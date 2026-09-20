import React, { useRef, useState, useEffect, useCallback } from 'react';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const snapToC = (noteIndex) => {
  const notesFromC = noteIndex % 12;
  if (notesFromC <= 1) return noteIndex - notesFromC;
  if (notesFromC >= 11) return noteIndex + (12 - notesFromC);
  return noteIndex;
};

export function DualSlider({ 
  min, 
  max, 
  value, 
  onChange, 
  disabled, 
  minDistance = 12
}) {
  const [low, high] = value;
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(null);

  const getValFromMouseEvent = useCallback((e) => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const rawVal = percent * (max - min) + min;
    return snapToC(Math.round(rawVal));
  }, [min, max]);

  const handlePointerDown = (thumb, e) => {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    setDragging(thumb);
  };

  useEffect(() => {
    if (!dragging) return;

    const handlePointerMove = (e) => {
      const newVal = getValFromMouseEvent(e);
      if (dragging === 'low') {
        const snapped = Math.max(min, Math.min(newVal, high - minDistance));
        if (snapped !== low) {
          onChange([snapped, high]);
        }
      } else if (dragging === 'high') {
        const snapped = Math.max(low + minDistance, Math.min(newVal, max));
        if (snapped !== high) {
          onChange([low, snapped]);
        }
      }
    };

    const handlePointerUp = () => {
      setDragging(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragging, getValFromMouseEvent, low, high, min, max, minDistance, onChange]);

  const lowPercent = ((low - min) / (max - min)) * 100;
  const highPercent = ((high - min) / (max - min)) * 100;

  const getLowOctave = () => Math.floor(low / 12) - 1;
  const getHighOctave = () => Math.floor(high / 12) - 1;
  const getLowNoteName = () => NOTE_NAMES[low % 12];
  const getHighNoteName = () => NOTE_NAMES[high % 12];

  return (
    <div 
      className={`relative h-8 flex items-center w-full ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <div 
        ref={trackRef}
        className="absolute w-full h-2 rounded-full bg-secondary border border-border/50"
      >
        <div 
          className="absolute h-full bg-primary/40 rounded-full pointer-events-none"
          style={{ left: `${lowPercent}%`, right: `${100 - highPercent}%` }}
        />
      </div>
      
      <div
        className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-md cursor-grab active:cursor-grabbing transform -translate-x-1/2 hover:scale-110 transition-transform flex items-center justify-center"
        style={{ left: `${lowPercent}%`, top: '-2px' }}
        onPointerDown={(e) => handlePointerDown('low', e)}
      >
        <div className="absolute -bottom-6 text-[10px] font-medium whitespace-nowrap text-foreground">
          {getLowNoteName()}{getLowOctave()}
        </div>
      </div>
      
      <div
        className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-md cursor-grab active:cursor-grabbing transform -translate-x-1/2 hover:scale-110 transition-transform flex items-center justify-center"
        style={{ left: `${highPercent}%`, top: '-2px' }}
        onPointerDown={(e) => handlePointerDown('high', e)}
      >
        <div className="absolute -bottom-6 text-[10px] font-medium whitespace-nowrap text-foreground">
          {getHighNoteName()}{getHighOctave()}
        </div>
      </div>
    </div>
  );
}
