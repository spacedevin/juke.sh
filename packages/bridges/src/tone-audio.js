import * as Tone from 'tone'

/**
 * Tone.js selection chime + pink-noise hum for card taps.
 * @param {{ audioEnabled: boolean }} mode - scene mode object (mutated via bindAudioMode)
 */
export function createToneAudio(mode) {
  let audioInitialized = false
  let beepSynth, humSynth, humFilter

  async function initAudio() {
    if (audioInitialized) return
    await Tone.start()
    beepSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.2, sustain: 0.2, release: 1 },
    }).toDestination()
    beepSynth.volume.value = -10
    humSynth = new Tone.Noise('pink')
    humFilter = new Tone.Filter(150, 'lowpass').toDestination()
    humSynth.connect(humFilter)
    humSynth.volume.value = -25
    audioInitialized = true
  }

  function disposeAudio() {
    if (!audioInitialized) return
    try { humSynth.stop() } catch {}
    try { humSynth.dispose() } catch {}
    try { humFilter.dispose() } catch {}
    try { beepSynth.dispose() } catch {}
    audioInitialized = false
  }

  async function playSelectionSound() {
    if (!mode.audioEnabled) return
    await initAudio()
    if (!audioInitialized) return
    beepSynth.triggerAttackRelease(['C4', 'E4', 'G4'], '8n')
    if (humSynth.state !== 'started') humSynth.start()
  }

  function bindAudioMode() {
    mode.setAudioEnabled = (enabled) => {
      if (!enabled && audioInitialized && humSynth?.state === 'started') {
        try { humSynth.stop() } catch {}
      }
    }
  }

  return { initAudio, disposeAudio, playSelectionSound, bindAudioMode }
}

export { createToneAudio as default }
