'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, startTransition, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { motion, AnimatePresence } from 'framer-motion';
import { TranscriptSegmentData } from '@/types';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { useTranscriptStreaming } from '@/hooks/useTranscriptStreaming';
import { ConfidenceIndicator } from './ConfidenceIndicator';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { RecordingStatusBar } from './RecordingStatusBar';

export interface VirtualizedTranscriptViewProps {
  segments: TranscriptSegmentData[];
  isRecording?: boolean;
  isPaused?: boolean;
  isProcessing?: boolean;
  isStopping?: boolean;
  enableStreaming?: boolean;
  showConfidence?: boolean;
  disableAutoScroll?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
}

const VIRTUALIZATION_THRESHOLD = 10;

function formatRecordingTime(seconds: number | undefined): string {
  if (seconds === undefined) {
    return '[--:--]';
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;

  return `[${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

function cleanStopWords(text: string): string {
  const stopWords = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

  let cleanedText = text;
  stopWords.forEach((word) => {
    const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
    cleanedText = cleanedText.replace(pattern, ' ');
  });

  return cleanedText.replace(/\s+/g, ' ').trim();
}

function lanePresentation(sourceLane?: string, displaySpeaker?: string) {
  if (sourceLane === 'mic_in') {
    return {
      speaker: displaySpeaker || 'Me',
      alignClass: 'justify-end',
      contentClass: 'items-end text-right ml-auto',
      metaClass: 'flex-row-reverse text-emerald-700/80 dark:text-emerald-300/80',
      badgeClass:
        'bg-emerald-500/12 text-emerald-800 dark:text-emerald-200 border border-emerald-500/20',
      bubbleClass:
        'bg-emerald-500/12 border-emerald-500/20',
      draftRingClass: 'ring-emerald-500/20',
    };
  }

  if (sourceLane === 'system_out') {
    return {
      speaker: displaySpeaker || 'Them',
      alignClass: 'justify-start',
      contentClass: 'items-start text-left',
      metaClass: 'text-slate-600 dark:text-slate-300',
      badgeClass:
        'bg-slate-500/10 text-slate-700 dark:text-slate-200 border border-slate-500/15',
      bubbleClass:
        'bg-slate-500/10 border-slate-500/15',
      draftRingClass: 'ring-slate-400/20',
    };
  }

  return {
    speaker: displaySpeaker || 'Audio',
    alignClass: 'justify-start',
    contentClass: 'items-start text-left',
    metaClass: 'text-muted-foreground',
    badgeClass: 'bg-muted text-muted-foreground border border-border',
    bubbleClass: 'bg-card border-border',
    draftRingClass: 'ring-border',
  };
}

const TranscriptSegment = memo(function TranscriptSegment({
  id,
  timestamp,
  text,
  confidence,
  sourceLane,
  displaySpeaker,
  isFinal,
  isStreaming,
  showConfidence,
}: {
  id: string;
  timestamp: number;
  text: string;
  confidence?: number;
  sourceLane?: string;
  displaySpeaker?: string;
  isFinal?: boolean;
  isStreaming: boolean;
  showConfidence: boolean;
}) {
  const displayText = cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);
  const lane = lanePresentation(sourceLane, displaySpeaker);
  const isDraft = isFinal === false;

  return (
    <div id={`segment-${id}`} className={`mb-3 flex w-full ${lane.alignClass}`}>
      <div className={`flex max-w-[88%] flex-col gap-1 ${lane.contentClass}`}>
        <div className={`flex items-center gap-2 text-[11px] font-medium ${lane.metaClass}`}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{formatRecordingTime(timestamp)}</span>
            </TooltipTrigger>
            <TooltipContent>
              {confidence !== undefined && showConfidence ? (
                <ConfidenceIndicator confidence={confidence} showIndicator={showConfidence} />
              ) : (
                <span className="text-xs text-muted-foreground">No confidence score</span>
              )}
            </TooltipContent>
          </Tooltip>
          <span className={`rounded-full px-2 py-0.5 text-[11px] ${lane.badgeClass}`}>
            {lane.speaker}
          </span>
          {isDraft && (
            <span className="rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Draft
            </span>
          )}
        </div>

        <div
          className={[
            'rounded-2xl border px-3 py-2 shadow-sm transition-colors',
            lane.bubbleClass,
            isDraft ? `ring-1 ${lane.draftRingClass}` : '',
            isStreaming ? 'shadow-md' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <p
            className={[
              'text-[15px] leading-6 text-foreground',
              isDraft ? 'italic text-foreground/85' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {displayText}
          </p>
        </div>
      </div>
    </div>
  );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
  segments,
  isRecording = false,
  isPaused = false,
  isProcessing = false,
  isStopping = false,
  enableStreaming = false,
  showConfidence = true,
  disableAutoScroll = false,
  hasMore = false,
  isLoadingMore = false,
  totalCount = 0,
  loadedCount = 0,
  onLoadMore,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 88,
    overscan: 10,
    onChange: () => {
      startTransition(() => {
        rerender();
      });
    },
  });

  const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
    segments,
    isRecording,
    enableStreaming
  );

  const latestSegment = segments.length > 0 ? segments[segments.length - 1] : null;
  const activeSegmentSignature = useMemo(() => {
    if (!latestSegment) {
      return '';
    }

    const latestText = getDisplayText(latestSegment);
    return `${latestSegment.id}:${latestText}`;
  }, [latestSegment, getDisplayText]);

  useAutoScroll({
    scrollRef,
    segments,
    isRecording,
    isPaused,
    virtualizer,
    virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
    disableAutoScroll,
    activeSegmentSignature,
  });

  useEffect(() => {
    if (!onLoadMore || !hasMore || isLoadingMore || isRecording || segments.length === 0) {
      return;
    }

    const triggerElement = loadMoreTriggerRef.current;
    if (!triggerElement) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          onLoadMore();
        }
      },
      {
        root: null,
        rootMargin: '100px',
        threshold: 0,
      }
    );

    observer.observe(triggerElement);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, onLoadMore, isRecording, segments.length]);

  useEffect(() => {
    if (!onLoadMore || !hasMore || isLoadingMore || isRecording) {
      return;
    }

    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }

    let ticking = false;

    const handleScroll = () => {
      if (ticking || isLoadingMore || !hasMore) {
        return;
      }

      ticking = true;
      requestAnimationFrame(() => {
        const { scrollTop, scrollHeight, clientHeight } = scrollElement;
        const scrollBottom = scrollHeight - scrollTop - clientHeight;

        if (scrollBottom < 200 && hasMore && !isLoadingMore) {
          onLoadMore();
        }
        ticking = false;
      });
    };

    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollElement.removeEventListener('scroll', handleScroll);
  }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

  const useVirtualization = segments.length >= VIRTUALIZATION_THRESHOLD;

  const listeningHint = useMemo(() => {
    if (isPaused) {
      return {
        title: 'Recording paused',
        subtitle: 'Resume to continue live notes.',
      };
    }

    return {
      title: 'Listening for speech...',
      subtitle: 'Mic shows up as Me. System audio shows up as Them.',
    };
  }, [isPaused]);

  const renderSegment = useCallback(
    (segment: TranscriptSegmentData) => {
      const isStreaming = streamingSegmentId === segment.id;

      return (
        <TranscriptSegment
          id={segment.id}
          timestamp={segment.timestamp}
          text={getDisplayText(segment)}
          confidence={segment.confidence}
          sourceLane={segment.sourceLane}
          displaySpeaker={segment.displaySpeaker}
          isFinal={segment.isFinal}
          isStreaming={isStreaming}
          showConfidence={showConfidence}
        />
      );
    },
    [getDisplayText, showConfidence, streamingSegmentId]
  );

  return (
    <div ref={scrollRef} className="flex h-full flex-col overflow-y-auto px-4 py-2">
      <AnimatePresence>
        {isRecording && (
          <div className="sticky top-0 z-10 bg-background pb-2">
            <RecordingStatusBar isPaused={isPaused} />
          </div>
        )}
      </AnimatePresence>

      <div className={isRecording ? 'pt-2' : ''}>
        {segments.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-8 text-center text-muted-foreground"
          >
            {isRecording ? (
              <>
                <div className="mb-3 flex items-center justify-center">
                  <div
                    className={`h-3 w-3 rounded-full ${
                      isPaused ? 'bg-orange-500' : 'bg-emerald-500 animate-pulse'
                    }`}
                  />
                </div>
                <p className="text-sm text-foreground">{listeningHint.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{listeningHint.subtitle}</p>
              </>
            ) : (
              <>
                <p className="text-lg font-semibold text-foreground">Welcome to Friday</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Start recording to see live Me and Them lanes.
                </p>
              </>
            )}
          </motion.div>
        ) : useVirtualization ? (
          <>
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const segment = segments[virtualRow.index];

                return (
                  <div
                    key={segment.id}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {renderSegment(segment)}
                  </div>
                );
              })}
            </div>

            {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
              <div ref={loadMoreTriggerRef} className="mt-2 flex items-center justify-center py-4">
                {isLoadingMore ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-foreground" />
                    <span className="text-sm">Loading more...</span>
                  </div>
                ) : hasMore && totalCount > 0 ? (
                  <span className="text-sm text-muted-foreground">
                    Showing {loadedCount} of {totalCount} segments
                  </span>
                ) : null}
              </div>
            )}

            {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="mt-4 flex items-center gap-2 text-muted-foreground"
              >
                <div className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                <span className="text-sm">Updating live transcript...</span>
              </motion.div>
            )}
          </>
        ) : (
          <>
            <div className="space-y-1">
              {segments.map((segment) => (
                <motion.div
                  key={segment.id}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {renderSegment(segment)}
                </motion.div>
              ))}
            </div>

            {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
              <div ref={loadMoreTriggerRef} className="mt-2 flex items-center justify-center py-4">
                {isLoadingMore ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-foreground" />
                    <span className="text-sm">Loading more...</span>
                  </div>
                ) : hasMore && totalCount > 0 ? (
                  <span className="text-sm text-muted-foreground">
                    Showing {loadedCount} of {totalCount} segments
                  </span>
                ) : null}
              </div>
            )}

            {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="mt-4 flex items-center gap-2 text-muted-foreground"
              >
                <div className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                <span className="text-sm">Updating live transcript...</span>
              </motion.div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
