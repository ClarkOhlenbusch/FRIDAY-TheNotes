# 07 — Structured Output Schemas (Pydantic Models)

## Intent Classification

```python
from pydantic import BaseModel, Field
from typing import Literal, Optional
from datetime import datetime


class IntentClassification(BaseModel):
    """Output of the intent router."""
    intent: Literal["chat", "action", "triage", "proactive"]
    confidence: float = Field(ge=0.0, le=1.0, description="Classification confidence")
    reasoning: str = Field(description="Brief explanation of why this intent was chosen")
```

## Chat Responses

```python
class Priority(BaseModel):
    """A single prioritized item for triage mode."""
    rank: int = Field(ge=1, le=3)
    title: str = Field(description="One-line description of the priority")
    source: Literal["email", "calendar", "task", "other"]
    source_id: Optional[str] = Field(default=None, description="ID of the source item")
    urgency: Literal["now", "today", "this_week"]
    action: str = Field(description="Suggested next action in imperative form")


class TriageResponse(BaseModel):
    """Structured triage mode output."""
    acknowledgment: str = Field(description="Brief empathetic acknowledgment (1 sentence)")
    priorities: list[Priority] = Field(max_length=3, description="Top 3 priorities, ranked")
    hidden_count: int = Field(description="Number of items hidden/deprioritized")


class ProactiveNudge(BaseModel):
    """Output of the heartbeat proactive check."""
    should_nudge: bool = Field(description="Whether there's something worth nudging about")
    message: Optional[str] = Field(default=None, description="The nudge message (1-2 sentences)")
    related_event: Optional[str] = Field(default=None, description="Calendar event ID if relevant")
    related_emails: list[str] = Field(default_factory=list, description="Email IDs if relevant")
    urgency: Literal["low", "medium", "high"] = Field(default="medium")
```

## Approval Payloads

```python
class EmailDraft(BaseModel):
    """Email draft for human approval."""
    to: str
    subject: str
    body: str
    reply_to_id: Optional[str] = None
    cc: Optional[str] = None
    thread_context: Optional[str] = Field(
        default=None,
        description="Summary of the email thread for user context"
    )


class CalendarEventDraft(BaseModel):
    """Calendar event draft for human approval."""
    summary: str
    start: datetime
    end: datetime
    description: Optional[str] = None
    attendees: list[str] = Field(default_factory=list)
    location: Optional[str] = None


class ApprovalRequest(BaseModel):
    """Wrapper for any action requiring user approval."""
    action_type: Literal["send_email", "create_event"]
    payload: EmailDraft | CalendarEventDraft
    explanation: str = Field(description="Why FRIDAY wants to take this action")


class ApprovalResponse(BaseModel):
    """User's response to an approval request."""
    status: Literal["approved", "rejected", "edited"]
    edited_payload: Optional[dict] = Field(
        default=None,
        description="Modified payload if user edited the draft"
    )
```

## SSE Event Models

```python
class SSEEvent(BaseModel):
    """Base model for all SSE events."""
    type: Literal["status", "token", "tool_result", "approval_required", "done", "error"]
    data: dict


class StatusEvent(BaseModel):
    """Progress status update."""
    type: Literal["status"] = "status"
    message: str  # e.g. "Reading your emails...", "Checking calendar..."


class TokenEvent(BaseModel):
    """Streaming token."""
    type: Literal["token"] = "token"
    content: str  # The text chunk


class ToolResultEvent(BaseModel):
    """Tool execution result."""
    type: Literal["tool_result"] = "tool_result"
    tool_name: str
    success: bool
    summary: str  # Human-readable summary of what the tool found
    duration_ms: int


class ApprovalRequiredEvent(BaseModel):
    """Signals the frontend to show an approval dialog."""
    type: Literal["approval_required"] = "approval_required"
    approval_id: str
    request: ApprovalRequest


class DoneEvent(BaseModel):
    """Signals the response is complete."""
    type: Literal["done"] = "done"
    session_id: str
    message_id: str
    intent: str
    tool_calls_count: int
    total_duration_ms: int


class ErrorEvent(BaseModel):
    """Error occurred during processing."""
    type: Literal["error"] = "error"
    message: str
    recoverable: bool = True
```

## API Request/Response Models

```python
class ChatRequest(BaseModel):
    """Incoming chat request from the desktop app."""
    session_id: Optional[str] = Field(
        default=None,
        description="Existing session ID. If null, creates a new session."
    )
    message: str = Field(min_length=1, max_length=4000)
    user_id: str


class ApproveRequest(BaseModel):
    """User's response to an approval request."""
    session_id: str
    approval_id: str
    response: ApprovalResponse


class SessionResponse(BaseModel):
    """Session metadata."""
    id: str
    title: Optional[str]
    created_at: datetime
    updated_at: datetime
    message_count: int


class TaskResponse(BaseModel):
    """Task data returned from API."""
    id: str
    title: str
    description: Optional[str]
    priority: Literal["critical", "high", "medium", "low"]
    status: Literal["pending", "in_progress", "done", "dismissed"]
    due_at: Optional[datetime]
    source: str
    created_at: datetime
```
