"use client";

import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";

interface AudioPlayerProps {
  mediaUrl: string;
}

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];

export default function AudioPlayer({ mediaUrl }: AudioPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(false);

  // ── Mount / unmount wavesurfer ──────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "#52525b",        // zinc-600
      progressColor: "#c8a951",    // gold
      cursorColor: "#3b82f6",      // azure
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      height: 64,
      normalize: true,
      url: mediaUrl,
    });

    ws.on("ready", () => {
      setDuration(ws.getDuration());
    });

    ws.on("timeupdate", (time) => {
      setCurrentTime(time);
    });

    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => setIsPlaying(false));
    ws.on("finish", () => setIsPlaying(false));

    wsRef.current = ws;

    // Critical cleanup — prevent audio-context memory leaks
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [mediaUrl]);

  // ── Handlers ────────────────────────────────────────────────────
  const togglePlay = () => wsRef.current?.playPause();

  const toggleMute = () => {
    if (!wsRef.current) return;
    const next = !muted;
    wsRef.current.setMuted(next);
    setMuted(next);
  };

  const changeSpeed = (rate: number) => {
    if (!wsRef.current) return;
    wsRef.current.setPlaybackRate(rate);
    setSpeed(rate);
  };

  // ── Format seconds → mm:ss ─────────────────────────────────────
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      {/* Waveform */}
      <div ref={containerRef} className="mb-3" />

      {/* Controls */}
      <div className="flex items-center gap-3">
        {/* Play / Pause */}
        <button
          onClick={togglePlay}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-[#c8a951] text-zinc-900 transition hover:bg-[#d4b962] active:scale-95"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="ml-0.5 h-4 w-4" />
          )}
        </button>

        {/* Time */}
        <span className="min-w-[5rem] font-mono text-xs text-zinc-400">
          {fmt(currentTime)} / {fmt(duration)}
        </span>

        {/* Mute */}
        <button
          onClick={toggleMute}
          className="text-zinc-500 transition hover:text-zinc-300"
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted ? (
            <VolumeX className="h-4 w-4" />
          ) : (
            <Volume2 className="h-4 w-4" />
          )}
        </button>

        {/* Speed selector */}
        <div className="ml-auto flex items-center gap-1">
          {SPEED_OPTIONS.map((rate) => (
            <button
              key={rate}
              onClick={() => changeSpeed(rate)}
              className={`rounded px-2 py-0.5 text-xs transition ${
                speed === rate
                  ? "bg-[#3b82f6] text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {rate}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
