import { useState, useEffect, useRef } from 'react';
import { TranscriptSegmentData } from '@/types';

const INTERVAL_MS = 15; // Character reveal interval
const DURATION_MS = 800; // Total streaming duration
const INITIAL_CHARS = 5; // Show first N characters immediately

interface StreamingSegment {
  id: string;
  fullText: string;
  visibleText: string;
}

interface SegmentSnapshot {
  id: string;
  text: string;
}

/**
 * Hook to manage the typewriter/streaming effect for new transcripts
 * Gradually reveals characters in a transcript over 800ms
 */
export function useTranscriptStreaming(
  segments: TranscriptSegmentData[],
  isRecording: boolean,
  enableStreaming: boolean
) {
  const [streamingSegment, setStreamingSegment] = useState<StreamingSegment | null>(null);
  const lastSegmentSnapshotRef = useRef<SegmentSnapshot | null>(null);
  const streamingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const latestSegment = segments.length > 0 ? segments[segments.length - 1] : null;

  useEffect(() => {
    if (!isRecording || !enableStreaming || segments.length === 0) {
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }
      setStreamingSegment(null);
      lastSegmentSnapshotRef.current = null;
      return;
    }

    if (!latestSegment) {
      return;
    }

    const previousSnapshot = lastSegmentSnapshotRef.current;
    const isNewSegment = previousSnapshot?.id !== latestSegment.id;
    const previousText =
      !isNewSegment && previousSnapshot?.text ? previousSnapshot.text : '';
    const fullText = latestSegment.text;

    const shouldAnimateSuffix =
      !latestSegment.isFinal &&
      fullText.length > 0 &&
      (
        isNewSegment
          ? true
          : fullText.length > previousText.length && fullText.startsWith(previousText)
      );

    lastSegmentSnapshotRef.current = {
      id: latestSegment.id,
      text: fullText,
    };

    if (streamingIntervalRef.current) {
      clearInterval(streamingIntervalRef.current);
      streamingIntervalRef.current = null;
    }

    if (!shouldAnimateSuffix) {
      setStreamingSegment(null);
      return;
    }

    const startingText = isNewSegment
      ? fullText.substring(0, Math.min(INITIAL_CHARS, fullText.length))
      : previousText;

    setStreamingSegment({
      id: latestSegment.id,
      fullText,
      visibleText: startingText,
    });

    if (fullText.length <= startingText.length) {
      return;
    }

    const totalTicks = Math.floor(DURATION_MS / INTERVAL_MS);
    const remainingChars = fullText.length - startingText.length;
    const charsPerTick = Math.max(1, Math.ceil(remainingChars / totalTicks));

    let charIndex = startingText.length;

    streamingIntervalRef.current = setInterval(() => {
      charIndex += charsPerTick;

      if (charIndex >= fullText.length) {
        setStreamingSegment({
          id: latestSegment.id,
          fullText,
          visibleText: fullText,
        });

        if (streamingIntervalRef.current) {
          clearInterval(streamingIntervalRef.current);
          streamingIntervalRef.current = null;
        }
      } else {
        setStreamingSegment((prev) =>
          prev
            ? {
                ...prev,
                visibleText: fullText.substring(0, charIndex),
              }
            : null
        );
      }
    }, INTERVAL_MS);

    return () => {
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }
    };
  }, [
    latestSegment?.id,
    latestSegment?.text,
    latestSegment?.isFinal,
    segments.length,
    isRecording,
    enableStreaming,
  ]);

  useEffect(() => {
    return () => {
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }
      lastSegmentSnapshotRef.current = null;
    };
  }, []);

  /**
   * Get the display text for a segment, with streaming effect if applicable
   */
  const getDisplayText = (segment: TranscriptSegmentData): string => {
    if (streamingSegment && segment.id === streamingSegment.id) {
      return streamingSegment.visibleText;
    }
    return segment.text;
  };

  return {
    streamingSegmentId: streamingSegment?.id ?? null,
    getDisplayText,
  };
}
