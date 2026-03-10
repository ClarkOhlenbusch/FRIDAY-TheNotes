'use client';

import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { recordingService } from '@/services/recordingService';
import { transcriptService } from '@/services/transcriptService';
import { useRecordingState } from './RecordingStateContext';

const AUTO_STOP_IDLE_MS = 15 * 60 * 1000;
const SLEEP_GAP_MS = 2 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 30 * 1000;

declare global {
  interface Window {
    handleRecordingStop?: (callApi?: boolean) => Promise<void>;
  }
}

export function RecordingSessionGuardProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const recordingState = useRecordingState();
  const lastActivityAtRef = useRef<number>(Date.now());
  const lastTickAtRef = useRef<number>(Date.now());
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);
  const autoStopInFlightRef = useRef(false);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const isEligibleForAutoStop = useCallback(() => {
    return (
      recordingState.isRecording &&
      !recordingState.isPaused &&
      !recordingState.isStopping &&
      !recordingState.isProcessing &&
      !recordingState.isSaving
    );
  }, [
    recordingState.isPaused,
    recordingState.isProcessing,
    recordingState.isRecording,
    recordingState.isSaving,
    recordingState.isStopping,
  ]);

  const maybeAutoStop = useCallback(
    async (reason: 'idle' | 'sleep') => {
      if (autoStopInFlightRef.current || !isEligibleForAutoStop()) {
        return;
      }

      autoStopInFlightRef.current = true;
      clearIdleTimer();

      const description =
        reason === 'sleep'
          ? 'Friday resumed after a long sleep gap and is ending the live note session.'
          : 'No new audio was detected for 15 minutes, so Friday stopped the live note session.';

      toast.info('Stopping recording automatically', {
        description,
        duration: 6000,
      });

      try {
        await recordingService.stopRecording('');

        if (typeof window.handleRecordingStop === 'function') {
          await window.handleRecordingStop(true);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes('No recording in progress')) {
          console.error('[RecordingSessionGuard] Auto-stop failed:', error);
          toast.error('Automatic stop failed', {
            description: errorMessage,
          });
        }
      } finally {
        autoStopInFlightRef.current = false;
        lastActivityAtRef.current = Date.now();
        lastTickAtRef.current = Date.now();
      }
    },
    [clearIdleTimer, isEligibleForAutoStop]
  );

  const resetActivity = useCallback(() => {
    lastActivityAtRef.current = Date.now();

    if (!isEligibleForAutoStop() || autoStopInFlightRef.current) {
      clearIdleTimer();
      return;
    }

    clearIdleTimer();
    idleTimerRef.current = setTimeout(() => {
      void maybeAutoStop('idle');
    }, AUTO_STOP_IDLE_MS);
  }, [clearIdleTimer, isEligibleForAutoStop, maybeAutoStop]);

  useEffect(() => {
    if (!isEligibleForAutoStop()) {
      clearIdleTimer();
      autoStopInFlightRef.current = false;
      lastActivityAtRef.current = Date.now();
      lastTickAtRef.current = Date.now();
      return;
    }

    resetActivity();
  }, [clearIdleTimer, isEligibleForAutoStop, resetActivity]);

  useEffect(() => {
    let unlistenSpeechDetected: (() => void) | undefined;
    let unlistenTranscriptUpdate: (() => void) | undefined;

    const setupListeners = async () => {
      unlistenSpeechDetected = await recordingService.onSpeechDetected(() => {
        resetActivity();
      });

      unlistenTranscriptUpdate = await transcriptService.onTranscriptUpdate(() => {
        resetActivity();
      });
    };

    setupListeners().catch((error) => {
      console.error('[RecordingSessionGuard] Failed to setup activity listeners:', error);
    });

    return () => {
      if (unlistenSpeechDetected) {
        unlistenSpeechDetected();
      }
      if (unlistenTranscriptUpdate) {
        unlistenTranscriptUpdate();
      }
    };
  }, [resetActivity]);

  useEffect(() => {
    if (!recordingState.isRecording) {
      return;
    }

    lastTickAtRef.current = Date.now();

    const interval = setInterval(() => {
      const now = Date.now();
      const tickGap = now - lastTickAtRef.current;
      lastTickAtRef.current = now;

      if (tickGap > SLEEP_GAP_MS && isEligibleForAutoStop()) {
        void maybeAutoStop('sleep');
      }
    }, WATCHDOG_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isEligibleForAutoStop, maybeAutoStop, recordingState.isRecording]);

  useEffect(() => {
    return () => {
      clearIdleTimer();
    };
  }, [clearIdleTimer]);

  return <>{children}</>;
}
