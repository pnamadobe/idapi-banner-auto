/*
 * One-shot confetti burst on a full-screen canvas (no dependencies).
 * Mounted when a job completes; removes itself after ~4s. Skipped when the user
 * prefers reduced motion.
 */
import React, { useEffect, useRef } from 'react';

const COLORS = ['#e03131', '#1971c2', '#f08c00', '#2f9e44', '#9c36b5', '#0c8599'];

function Confetti({ onDone }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!canvas || reduced) { if (onDone) onDone(); return undefined; }
    const ctx = canvas.getContext('2d');
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    const pieces = Array.from({ length: 160 }, () => ({
      x: canvas.width / 2 + (Math.random() - 0.5) * 120,
      y: canvas.height * 0.35,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 14 - 4,
      size: 5 + Math.random() * 6,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4
    }));
    const start = performance.now();
    let frame;
    const tick = (now) => {
      const t = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach((p) => {
        p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - 2800) / 1200);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      });
      if (t < 4000) frame = requestAnimationFrame(tick);
      else if (onDone) onDone();
    };
    frame = requestAnimationFrame(tick);
    window.addEventListener('resize', resize);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize); };
  }, []);

  return <canvas ref={ref} aria-hidden="true" style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1000 }} />;
}

export default Confetti;
