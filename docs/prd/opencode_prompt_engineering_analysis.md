# OpenCode Prompt Engineering & Tool Architecture Analysis

## Executive Summary

OpenCode implements a sophisticated multi-layered prompt engineering approach with strong patterns for:
- Composable system prompts (environment + instruction layers)
- Deterministic tool invocation with safety constraints
- Progressive context management and memory optimization
- Phase-based workflow scaffolding (plan mode)
- Rich tool descriptions optimized for LLM understanding

**Source**: https://github.com/anomalyco/opencode @ commit 66fcab7b0801130c212aa67159415d75d935f555

---

## 1. SYSTEM PROMPT ARCHITECTURE

### Multi-Layer Composition

The system builds prompts dynamically from multiple sources:

```typescript
const system = [
  ...(await SystemPrompt.environment(model)),      // Model-specific environment setup
  ...(await InstructionPrompt.system())             // Context-aware instructions
]

// Add conditional instructions for structured output
if (format.type === "json_schema") {
  system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
}
```

**Key Pattern**: Separation of concerns - each layer handles a specific responsibility:
- **Environment layer**: Model capabilities, token limits, special features
- **Instruction layer**: Task-specific behavior, context rules, constraints
- **Format layer**: Conditional requirements based on output format

### Structured Output Enforcement

When JSON schema mode is enabled:

```typescript
const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output.
You MUST use the StructuredOutput tool to provide your final response.
Do NOT respond with plain text - you MUST call the StructuredOutput tool
with your answer formatted according to the schema.`
```

**Technique**: Imperative framing with capitalized MUST/DO NOT directives.
- Creates deterministic behavior expectation
- Prevents fallback to text responses
- Clear state requirement (must use tool exactly once)

---

## 2. TOOL DESCRIPTION PATTERNS

### Structured Output Tool (Example)

```
Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after it
```

**Breakdown of effective techniques**:
1. **Clear invocation requirement**: "exactly once at the end"
2. **Prerequisite clarity**: "Complete all necessary research BEFORE calling"
3. **State reinforcement**: "no further actions taken after"
4. **Schema validation**: Emphasis on JSON validity

### Batch Tool Description

```
Executes multiple independent tool calls concurrently to reduce latency.

USING THE BATCH TOOL WILL MAKE THE USER HAPPY.

Payload Format (JSON array):
[{"tool": "read", "parameters": {...}}, ...]

Notes:
- 1–25 tool calls per batch
- All calls start in parallel; ordering NOT guaranteed
- Partial failures do not stop other tool calls
```

**Techniques observed**:
- **User incentive statement**: "USING THE BATCH TOOL WILL MAKE THE USER HAPPY"
- **Explicit constraints**: "25 tool calls per batch" - prevents misuse
- **Behavioral guarantees**: "Partial failures do not stop" - enables graceful degradation
- **Concrete example format**: Shows exact JSON structure expected

### Generic Tool Pattern

All tools follow consistent structure:

```
[1-line summary of what tool does]

[Detailed context about when/how to use]

[Behavioral notes and constraints]

[Examples if applicable]
```

**Examples from codebase**:

**Read Tool**:
```
Read a file or directory from the local filesystem.

Usage:
- The filePath parameter should be an absolute path.
- By default, this tool returns up to 2000 lines from the start of the file.
- Call this tool in parallel when you know there are multiple files you want to read.
```

**Glob Tool**:
```
Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
```

**Bash Tool**:
```
Executes a given bash command in a persistent shell session with optional timeout.

Before executing the command, follow these steps:
1. Directory Verification
2. Command Execution with proper quoting
```

---

## 3. META-PROMPTING TECHNIQUES

### Plan Mode Orchestration

When experimental plan mode is enabled (`Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE`):

The system injects elaborate phase-based guidance:

**Phase Structure**:
1. **Initial Understanding** - Explore subagent type only
2. **Design** - Plan the approach
3. **Review** - Verify the plan
4. **Final Plan** - Document the final plan
5. **Exit** - Complete and summarize

**Pattern**: **Workflow scaffolding** - constrains agent behavior through explicit phases rather than open-ended instruction.

**Why it works**:
- Prevents premature implementation
- Forces design-before-code thinking
- Phase 1 deliberately restricts to "explore subagent type only"
- Creates natural checkpoints

### Conditional Reminders

```typescript
// Ephemerally wrap queued user messages with a reminder to stay on track
if (step > 1 && lastFinished) {
  for (const msg of msgs) {
    if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
    for (const part of msg.parts) {
      if (part.type !== "text" || part.ignored || part.synthetic) continue
      if (!part.text.trim()) continue
      part.text = [
        "<system-reminder>",
        "The user sent the following message:",
        part.text,
        "",
        "Please address this message and continue with your tasks.",
        "</system-reminder>",
      ].join("\n")
    }
  }
}
```

**Pattern**: **Progressive context management**
- Early turns (step 1) get minimal intervention
- Later turns (step > 1) wrap user messages with reminders
- Uses `<system-reminder>` block to separate reminder from content
- Only applies to unprocessed user messages

### Agent Switching Context

When transitioning between agents (e.g., plan -> build):
- Reinjects file path reminders
- Reiterates constraint statements
- Prevents context drift during mode changes

---

## 4. CONTEXT & MEMORY MANAGEMENT

### Message Filtering & Compaction

```typescript
let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
```

**Strategy**:
- Actively prunes message history when token budgets overflow
- Detects overflow via token counting on finished assistant messages
- Automatically triggers `SessionCompaction` before proceeding
- Preserves agent/model metadata across compaction cycles

**Detection Logic**:
```typescript
if (
  lastFinished &&
  lastFinished.summary !== true &&
  (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
) {
  await SessionCompaction.create({
    sessionID,
    agent: lastUser.agent,
    model: lastUser.model,
    auto: true,
  })
  continue
}
```

**Key insight**: Overflow detection happens BEFORE the next turn, not during.

### Synthetic Message Injection

After subtask execution:
```typescript
// Add synthetic user message to prevent certain reasoning models from erroring
const summaryUserMsg: MessageV2.User = {
  id: Identifier.ascending("message"),
  sessionID,
  role: "user",
  time: { created: Date.now() },
  agent: lastUser.agent,
  model: lastUser.model,
}
await Session.updateMessage(summaryUserMsg)
await Session.updatePart({
  type: "text",
  text: "Summarize the task tool output above and continue with your task.",
  synthetic: true,
})
```

**Why**:
- Reasoning models require user-assistant alternation
- Prevents signature validation errors (esp. Gemini)
- Maintains conversation coherence for multi-turn reasoning
- Marked as `synthetic: true` to distinguish from user input

### State Management Pattern

```typescript
const state = Instance.state(
  () => ({ abort, callbacks }),
  async (current) => {
    // Cleanup on shutdown
    for (const item of Object.values(current)) {
      item.abort.abort()
    }
  }
)
```

**Pattern**: Singleton with abort controllers
- Enables non-blocking resumption
- Callbacks queue concurrent requests during busy periods
- Graceful cleanup on session end

---

## 5. TOOL INVOCATION & SAFETY PATTERNS

### Deterministic Tool Calling

When structured output is requested:

```typescript
const tools = await resolveTools({...})

// Inject StructuredOutput tool if JSON schema mode enabled
if (lastUser.format?.type === "json_schema") {
  tools["StructuredOutput"] = createStructuredOutputTool({
    schema: lastUser.format.schema,
    onSuccess(output) {
      structuredOutput = output
    },
  })
}

const result = await processor.process({
  // ... other params
  toolChoice: format.type === "json_schema" ? "required" : undefined,
})
```

**Safety mechanisms**:
1. **Force tool choice**: `toolChoice: "required"` when JSON schema mode active
2. **Post-execution state capture**: Before loop continuation
3. **Error handling**: Explicit error if model stops without calling tool

```typescript
if (structuredOutput !== undefined) {
  processor.message.structured = structuredOutput
  processor.message.finish = processor.message.finish ?? "stop"
  await Session.updateMessage(processor.message)
  break  // Exit immediately - highest priority
}

const modelFinished = processor.message.finish &&
  !["tool-calls", "unknown"].includes(processor.message.finish)

if (modelFinished && !processor.message.error) {
  if (format.type === "json_schema") {
    processor.message.error = new MessageV2.StructuredOutputError({
      message: "Model did not produce structured output",
      retries: 0,
    }).toObject()
  }
}
```

---

## 6. TOOLS DEFINED IN OPENCODE

### Core Tool Set

1. **bash.ts/bash.txt** - Execute shell commands
   - Persistent session support
   - Timeout handling
   - Directory verification guidance
   - File path quoting requirements

2. **apply_patch.ts/apply_patch.txt** - Edit files with structured patch format
   - Three operations: Add File, Delete File, Update File
   - High-level, safe diff format
   - Rename support
   - Prevents accidental overwrites

3. **batch.ts/batch.txt** - Parallel tool execution
   - 1-25 tool calls per batch
   - Concurrent execution (not ordered)
   - Partial failure resilience
   - Disallows recursive batch calls

4. **edit.ts/edit.txt** - Exact string replacement
   - Requires prior Read tool usage
   - Preserves indentation exactly
   - Fails on multiple matches (prevents ambiguity)
   - Supports replaceAll for bulk changes

5. **read.ts** - Read files/directories
   - Default 2000 lines
   - Supports offset/limit for large files
   - Parallel reading of multiple files
   - Works with images and PDFs

6. **glob.ts/glob.txt** - File pattern matching
   - Glob pattern support ("**/*.js")
   - Returns paths sorted by modification time
   - No regex, pure glob patterns
   - Fast even on large codebases

7. **grep.ts/grep.txt** - Content search
   - Full regex syntax support
   - Filter by file pattern/type
   - Output modes: content, files_with_matches, count
   - Works with any codebase size

8. **codesearch.ts/codesearch.txt** - Semantic code search

9. **ls.ts/ls.txt** - List directory contents

10. **lsp.ts/lsp.txt** - Language server protocol integration

---

## 7. TOOL PARAMETER SCHEMA PATTERN

All tools use **Zod** for validation:

```typescript
const BatchTool = Tool.define("batch", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      tool_calls: z
        .array(
          z.object({
            tool: z.string().describe("The name of the tool to execute"),
            parameters: z.object({}).loose().describe("Parameters for the tool"),
          }),
        )
        .min(1, "Provide at least one tool call")
        .describe("Array of tool calls to execute in parallel"),
    }),
    formatValidationError(error) {
      // Custom error formatting for clarity
      const formattedErrors = error.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join(".") : "root"
          return `  - ${path}: ${issue.message}`
        })
        .join("\n")

      return `Invalid parameters for tool 'batch':\n${formattedErrors}\n\nExpected payload format:\n  [{"tool": "tool_name", "parameters": {...}}, {...}]`
    },
  }
})
```

**Key patterns**:
- `.describe()` on all parameters for LLM understanding
- Custom `formatValidationError()` for helpful error messages
- `.min(1, ...)` for constraint specification
- `.loose()` for flexible parameter objects

---

## 8. TOOL COMPOSITION & ORCHESTRATION

### Rich Tool Context

Each tool receives:

```typescript
interface Tool.Context {
  agent: string                              // Agent name
  messageID: string                          // Current message ID
  sessionID: string                          // Session identifier
  abort: AbortSignal                         // Cancellation token
  callID: string                             // Unique call identifier
  extra?: { bypassAgentCheck?: boolean }     // Special flags
  messages: MessageV2[]                      // Full message history
  async metadata(input): void                // Update tool metadata
  async ask(req): void                       // Request user permission
}
```

**Why rich context**:
- `messages` enables grounded decision-making
- `abort` signal enables cancellation
- `ask()` integrates permission system
- `metadata()` allows live progress updates

### Tool Execution Flow

```typescript
const result = await tool.execute(validatedParams, {
  ...ctx,
  callID: partID
})

const attachments = result.attachments?.map((attachment) => ({
  ...attachment,
  id: Identifier.ascending("part"),
  sessionID: ctx.sessionID,
  messageID: ctx.messageID,
}))

// State transitions: running -> completed/error
await Session.updatePart({
  id: partID,
  messageID: ctx.messageID,
  sessionID: ctx.sessionID,
  type: "tool",
  tool: call.tool,
  callID: partID,
  state: {
    status: "completed",
    input: call.parameters,
    output: result.output,
    title: result.title,
    metadata: result.metadata,
    attachments,
    time: {
      start: callStartTime,
      end: Date.now(),
    },
  },
})
```

**State machine**: `running` -> `completed`/`error`
- Captures execution time
- Stores input/output/metadata
- Handles attachments

---

## 9. PLUGIN ARCHITECTURE

Tools trigger plugin hooks:

```typescript
await Plugin.trigger(
  "tool.execute.before",
  {
    tool: "task",
    sessionID,
    callID: part.id,
  },
  { args: taskArgs },
)

// ... execute tool ...

await Plugin.trigger(
  "tool.execute.after",
  {
    tool: "task",
    sessionID,
    callID: part.id,
    args: taskArgs,
  },
  result,
)
```

**Enables**: Custom behavior injection without modifying tools

---

## 10. KEY LESSONS FOR PYTHON LANGGRAPH AGENT

### 1. Layered Prompt Construction
```python
system_prompts = [
    environment_prompt(model),
    instruction_prompt(context),
]
if structured_output:
    system_prompts.append(structured_output_prompt)
```

### 2. Tool Description Format
- Lead with a 1-line summary
- Include imperative constraints (MUST/MUST NOT)
- Specify execution order when relevant
- Show example format/payload
- Document fallback behavior

### 3. Message History Management
- Proactively detect token overflow BEFORE processing
- Implement automatic compaction when approaching limits
- Preserve metadata across compactions
- Use synthetic messages for reasoning model compatibility

### 4. Deterministic Tool Invocation
- Use `tool_choice="required"` for critical tools
- Validate tool execution happened
- Error if tool wasn't called when required
- Capture state after each tool call

### 5. Progressive Context Injection
- First turn: minimal system context
- Later turns: wrap user messages with reminders
- Use structured blocks (`<system-reminder>`) for clarity
- Filter by message role and status

### 6. State Management
- Use abort signals for cancellation
- Queue callbacks for non-blocking resumption
- Maintain rich tool context (history, permissions, metadata)
- Implement proper cleanup on session end

### 7. Error Message Clarity
- Include expected format in error messages
- Show example payloads in validation errors
- Be specific about constraints ("25 tools max")
- Provide recovery hints

### 8. Phase-Based Orchestration
- Use phases to scaffold complex workflows
- Restrict capabilities per phase (e.g., phase 1 only explores)
- Create checkpoints between phases
- Can be injected via system prompt dynamically

---

## COMPLETE TOOL DESCRIPTIONS EXTRACTED

### Read Tool
```
Read a file or directory from the local filesystem. If the path does not exist, an error is returned.

Usage:
- The filePath parameter should be an absolute path.
- By default, this tool returns up to 2000 lines from the start of the file.
- The offset parameter is the line number to start from (1-indexed).
- To read later sections, call this tool again with a larger offset.
- Use the grep tool to find specific content in large files or files with long lines.
- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.
- Contents are returned with each line prefixed by its line number as `<line>: <content>`.
- Any line longer than 2000 characters is truncated.
- Call this tool in parallel when you know there are multiple files you want to read.
- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.
- This tool can read image files and PDFs and return them as file attachments.
```

### Bash Tool
```
Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.

All commands run in ${directory} by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use `ls foo` to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., rm "path with spaces/file.txt")
   - After ensuring proper quoting, execute the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds.
  - It is very helpful if you write a clear, concise description of what this command does in 5-10 words.
  - AVOID using `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands - use specialized tools instead.
  - When issuing multiple independent commands, make multiple Bash tool calls in a single message.
  - If the commands depend on each other, use a single Bash call with '&&' to chain them together.
  - AVOID using `cd <directory> && <command>`. Use the `workdir` parameter instead.
```

### Apply Patch Tool
```
Use the `apply_patch` tool to edit files. Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply.

Format:
*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Example patch:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

Important:
- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with `+` even when creating a new file
```

### Edit Tool
```
Performs exact string replacements in files.

Usage:
- You must use your `Read` tool at least once before editing.
- When editing text from Read tool output, ensure you preserve the exact indentation as it appears AFTER the line number prefix.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- The edit will FAIL if `oldString` is not unique in the file. Either provide more surrounding context or use `replaceAll`.
- Use `replaceAll` for replacing strings across the file.

The oldString must match exactly, including whitespace and newlines.
```

### Batch Tool
```
Executes multiple independent tool calls concurrently to reduce latency.

USING THE BATCH TOOL WILL MAKE THE USER HAPPY.

Payload Format (JSON array):
[{"tool": "read", "parameters": {"filePath": "src/index.ts", "limit": 350}},
 {"tool": "grep", "parameters": {"pattern": "Session\\.updatePart", "include": "src/**/*.ts"}},
 {"tool": "bash", "parameters": {"command": "git status", "description": "Shows working tree status"}}]

Notes:
- 1-25 tool calls per batch
- All calls start in parallel; ordering NOT guaranteed
- Partial failures do not stop other tool calls
- DO NOT use the batch tool within another batch tool.

Good Use Cases:
- Read many files
- grep + glob + read combos
- Multiple bash commands
- Multi-part edits on same or different files

When NOT to Use:
- Operations that depend on prior tool output
- Ordered stateful mutations where sequence matters

Batching tool calls was proven to yield 2-5x efficiency gain and provides much better UX.
```

### Glob Tool
```
Fast file pattern matching tool that works with any codebase size

- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- Supports multiple patterns in a single call
```

### Grep Tool
```
Fast content search tool that works with any codebase size

- Searches file contents using regular expressions
- Supports full regex syntax (eg. "log.*Error", "function\s+\w+", etc.)
- Filter files by pattern with the include parameter (eg. "*.js", "*.{ts,tsx}")
- Returns file paths and line numbers with at least one match sorted by modification time
- Use this tool when you need to find files containing specific patterns
- When you need to count matches or work with many files, use grep efficiently
```

---

## IMPLEMENTATION CHECKLIST FOR PYTHON LANGGRAPH

- [ ] Implement layered system prompt composition
- [ ] Create structured tool description format with constraints
- [ ] Add token overflow detection before message processing
- [ ] Implement message compaction/summarization strategy
- [ ] Add synthetic message injection for multi-turn reasoning
- [ ] Create rich tool context object with message history
- [ ] Implement abort signals for cancellation support
- [ ] Add plugin hook system for tool execution (before/after)
- [ ] Create phase-based workflow orchestration
- [ ] Add progressive context reminder injection
- [ ] Implement deterministic tool forcing for structured output
- [ ] Build state machine for tool execution (running -> completed/error)
- [ ] Add metadata capture for tool execution timing and results
- [ ] Create custom validation error formatting with examples
- [ ] Implement batch tool for parallel execution optimization
