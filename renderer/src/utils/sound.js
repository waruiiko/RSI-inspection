let ctx = null
function getCtx() {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

// Short two-tone chime: high note then lower note
export function playAlertSound() {
  try {
    const ac = getCtx()
    const now = ac.currentTime
    const tones = [880, 660]
    tones.forEach((freq, i) => {
      const osc  = ac.createOscillator()
      const gain = ac.createGain()
      osc.connect(gain)
      gain.connect(ac.destination)
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = now + i * 0.12
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18)
      osc.start(start)
      osc.stop(start + 0.2)
    })
  } catch {}
}
