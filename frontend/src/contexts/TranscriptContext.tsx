'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
  MutableRefObject,
} from 'react';
import { Transcript, TranscriptUpdate } from '@/types';
import { toast } from 'sonner';
import { useRecordingState } from './RecordingStateContext';
import { transcriptService } from '@/services/transcriptService';
import { recordingService } from '@/services/recordingService';
import { indexedDBService } from '@/services/indexedDBService';

interface TranscriptContextType {
  transcripts: Transcript[];
  transcriptsRef: MutableRefObject<Transcript[]>;
  addTranscript: (update: TranscriptUpdate) => void;
  copyTranscript: () => void;
  flushBuffer: () => void;
  transcriptContainerRef: React.RefObject<HTMLDivElement>;
  meetingTitle: string;
  setMeetingTitle: (title: string) => void;
  clearTranscripts: () => void;
  currentMeetingId: string | null;
  markMeetingAsSaved: () => Promise<void>;
}

const TranscriptContext = createContext<TranscriptContextType | undefined>(undefined);

function displaySpeakerForLane(sourceLane?: string | null, fallbackSource?: string | null): string {
  if (sourceLane === 'mic_in') {
    return 'Me';
  }
  if (sourceLane === 'system_out') {
    return 'Them';
  }
  return fallbackSource || 'Audio';
}

function sortTranscripts(a: Transcript, b: Transcript): number {
  const timeDiff =
    (a.audio_start_time ?? a.chunk_start_time ?? 0) -
    (b.audio_start_time ?? b.chunk_start_time ?? 0);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  const laneDiff = (a.source_lane ?? '').localeCompare(b.source_lane ?? '');
  if (laneDiff !== 0) {
    return laneDiff;
  }

  return (a.sequence_id ?? 0) - (b.sequence_id ?? 0);
}

function buildTranscriptId(update: Pick<TranscriptUpdate, 'source_lane' | 'segment_id'>): string {
  return `${update.source_lane}:${update.segment_id}`;
}

function transcriptMatchesUpdate(transcript: Transcript, update: TranscriptUpdate): boolean {
  return (
    transcript.segment_id === update.segment_id &&
    transcript.source_lane === update.source_lane
  );
}

function transcriptEquivalent(a: Transcript, b: Transcript): boolean {
  return (
    a.text === b.text &&
    a.is_partial === b.is_partial &&
    a.is_final === b.is_final &&
    a.confidence === b.confidence &&
    a.source === b.source &&
    a.source_lane === b.source_lane &&
    a.display_speaker === b.display_speaker &&
    a.segment_id === b.segment_id &&
    a.audio_start_time === b.audio_start_time &&
    a.audio_end_time === b.audio_end_time &&
    a.duration === b.duration &&
    a.chunk_start_time === b.chunk_start_time
  );
}

function findInsertIndex(items: Transcript[], nextTranscript: Transcript): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (sortTranscripts(items[index], nextTranscript) <= 0) {
      return index + 1;
    }
  }

  return 0;
}

function toTranscript(update: TranscriptUpdate): Transcript {
  return {
    id: buildTranscriptId(update),
    text: update.text,
    timestamp: update.timestamp,
    sequence_id: update.sequence_id,
    chunk_start_time: update.chunk_start_time,
    is_partial: update.is_partial,
    is_final: update.is_final,
    confidence: update.confidence,
    source: update.source,
    source_lane: update.source_lane,
    display_speaker: update.display_speaker,
    segment_id: update.segment_id,
    audio_start_time: update.audio_start_time,
    audio_end_time: update.audio_end_time,
    duration: update.duration,
  };
}

function upsertTranscript(prev: Transcript[], update: TranscriptUpdate): Transcript[] {
  const nextTranscript = toTranscript(update);
  const existingIndex = prev.findIndex((transcript) => transcriptMatchesUpdate(transcript, update));

  if (existingIndex === -1) {
    const insertIndex = findInsertIndex(prev, nextTranscript);
    return [
      ...prev.slice(0, insertIndex),
      nextTranscript,
      ...prev.slice(insertIndex),
    ];
  }

  const mergedTranscript = {
    ...prev[existingIndex],
    ...nextTranscript,
  };

  if (transcriptEquivalent(prev[existingIndex], mergedTranscript)) {
    return prev;
  }

  const next = [...prev];
  next[existingIndex] = mergedTranscript;
  return next;
}

export function TranscriptProvider({ children }: { children: ReactNode }) {
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [meetingTitle, setMeetingTitle] = useState('+ New Call');
  const [currentMeetingId, setCurrentMeetingId] = useState<string | null>(null);

  const recordingState = useRecordingState();
  const transcriptsRef = useRef<Transcript[]>(transcripts);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptsRef.current = transcripts;
  }, [transcripts]);

  useEffect(() => {
    let unlistenRecordingStarted: (() => void) | undefined;
    let unlistenRecordingStopped: (() => void) | undefined;

    const setupRecordingListeners = async () => {
      try {
        await indexedDBService.init();

        unlistenRecordingStarted = await recordingService.onRecordingStarted(async () => {
          try {
            const meetingId = `meeting-${Date.now()}`;
            setCurrentMeetingId(meetingId);
            sessionStorage.setItem('indexeddb_current_meeting_id', meetingId);

            const meetingName = await recordingService.getRecordingMeetingName();
            const effectiveTitle =
              meetingName ||
              `Meeting ${new Date()
                .toISOString()
                .slice(0, 19)
                .replace('T', '_')
                .replace(/:/g, '-')}`;

            await indexedDBService.saveMeetingMetadata({
              meetingId,
              title: effectiveTitle,
              startTime: Date.now(),
              lastUpdated: Date.now(),
              transcriptCount: 0,
              savedToSQLite: false,
              folderPath: undefined,
            });

            setMeetingTitle(effectiveTitle);

            try {
              const { invoke } = await import('@tauri-apps/api/core');
              const folderPath = await invoke<string>('get_meeting_folder_path');
              if (!folderPath) {
                return;
              }

              const metadata = await indexedDBService.getMeetingMetadata(meetingId);
              if (metadata) {
                metadata.folderPath = folderPath;
                await indexedDBService.saveMeetingMetadata(metadata);
              }
            } catch (error) {
              console.warn('Failed to persist meeting folder path to IndexedDB:', error);
            }
          } catch (error) {
            console.error('Failed to initialize meeting in IndexedDB:', error);
          }
        });

        unlistenRecordingStopped = await recordingService.onRecordingStopped(async (payload) => {
          try {
            if (!currentMeetingId) {
              return;
            }

            const metadata = await indexedDBService.getMeetingMetadata(currentMeetingId);
            if (metadata && payload.folder_path) {
              metadata.folderPath = payload.folder_path;
              await indexedDBService.saveMeetingMetadata(metadata);
            }
          } catch (error) {
            console.error('Failed to update meeting metadata on stop:', error);
          }
        });
      } catch (error) {
        console.error('Failed to setup recording listeners:', error);
      }
    };

    setupRecordingListeners();

    return () => {
      if (unlistenRecordingStarted) {
        unlistenRecordingStarted();
      }
      if (unlistenRecordingStopped) {
        unlistenRecordingStopped();
      }
    };
  }, [currentMeetingId]);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlistenFn = await transcriptService.onTranscriptUpdate((update) => {
          setTranscripts((prev) => upsertTranscript(prev, update));

          if (currentMeetingId && update.is_final) {
            indexedDBService
              .saveTranscript(currentMeetingId, update)
              .catch((err) => console.warn('IndexedDB save failed:', err));
          }
        });
      } catch (error) {
        console.error('Failed to setup transcript listener:', error);
      }
    };

    setupListener();

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [currentMeetingId]);

  useEffect(() => {
    const syncFromBackend = async () => {
      if (!recordingState.isRecording || transcripts.length > 0) {
        return;
      }

      try {
        const history = await transcriptService.getTranscriptHistory();
        const formattedTranscripts: Transcript[] = history
          .map((segment: any) => {
            const displaySpeaker = displaySpeakerForLane(segment.source_lane);
            return {
              id: segment.id,
              text: segment.text,
              timestamp: segment.display_time,
              sequence_id: segment.sequence_id,
              chunk_start_time: segment.audio_start_time,
              is_partial: false,
              is_final: true,
              confidence: segment.confidence,
              source: displaySpeaker,
              source_lane: segment.source_lane,
              display_speaker: displaySpeaker,
              segment_id: segment.id,
              audio_start_time: segment.audio_start_time,
              audio_end_time: segment.audio_end_time,
              duration: segment.duration,
            };
          })
          .sort(sortTranscripts);

        setTranscripts(formattedTranscripts);

        const meetingName = await recordingService.getRecordingMeetingName();
        if (meetingName) {
          setMeetingTitle(meetingName);
        }
      } catch (error) {
        console.error('[Reload Sync] Failed to sync from backend:', error);
      }
    };

    syncFromBackend();
  }, [recordingState.isRecording, transcripts.length]);

  const addTranscript = useCallback(
    (update: TranscriptUpdate) => {
      setTranscripts((prev) => upsertTranscript(prev, update));

      if (currentMeetingId && update.is_final) {
        indexedDBService
          .saveTranscript(currentMeetingId, update)
          .catch((err) => console.warn('IndexedDB save failed:', err));
      }
    },
    [currentMeetingId]
  );

  const copyTranscript = useCallback(() => {
    const formatTime = (seconds: number | undefined): string => {
      if (seconds === undefined) {
        return '[--:--]';
      }

      const totalSecs = Math.floor(seconds);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
    };

    const fullTranscript = transcripts
      .filter((transcript) => transcript.is_final !== false)
      .map((transcript) => {
        const speaker = displaySpeakerForLane(
          transcript.source_lane,
          transcript.display_speaker ?? transcript.source
        );
        return `${formatTime(transcript.audio_start_time)} ${speaker}: ${transcript.text}`;
      })
      .join('\n');

    navigator.clipboard.writeText(fullTranscript);
    toast.success('Transcript copied to clipboard');
  }, [transcripts]);

  const flushBuffer = useCallback(() => {
    transcriptsRef.current = transcriptsRef.current.sort(sortTranscripts);
  }, []);

  const clearTranscripts = useCallback(() => {
    setTranscripts([]);
  }, []);

  const markMeetingAsSaved = useCallback(async () => {
    const meetingId =
      currentMeetingId || sessionStorage.getItem('indexeddb_current_meeting_id');

    if (!meetingId) {
      console.error('[IndexedDB] Cannot mark meeting as saved: no meeting ID available');
      return;
    }

    try {
      await indexedDBService.markMeetingSaved(meetingId);
      setCurrentMeetingId(null);
      sessionStorage.removeItem('indexeddb_current_meeting_id');
    } catch (error) {
      console.error('[IndexedDB] Failed to mark meeting as saved:', error);
    }
  }, [currentMeetingId]);

  const value: TranscriptContextType = {
    transcripts,
    transcriptsRef,
    addTranscript,
    copyTranscript,
    flushBuffer,
    transcriptContainerRef,
    meetingTitle,
    setMeetingTitle,
    clearTranscripts,
    currentMeetingId,
    markMeetingAsSaved,
  };

  return <TranscriptContext.Provider value={value}>{children}</TranscriptContext.Provider>;
}

export function useTranscripts() {
  const context = useContext(TranscriptContext);
  if (context === undefined) {
    throw new Error('useTranscripts must be used within a TranscriptProvider');
  }
  return context;
}
