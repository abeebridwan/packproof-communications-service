import { isBrowserSupported } from 'livekit-client'

const blocked =
  'Voice needs WebRTC. Allow WebRTC for this site in your browser or extension settings, reload this page, and try again.'
export function microphoneMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotSupportedError') return blocked
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return 'No microphone was found. Connect a microphone, then try again.'
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return 'The microphone could not start. Close other apps using it, then try again.'
  return 'The microphone or voice connection could not start. Check microphone access and WebRTC-blocking extensions, then try again.'
}
export async function checkVoiceMedia() {
  let supported = false
  try {
    supported = isBrowserSupported()
  } catch {}
  if (!supported) throw new Error(blocked)
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    throw new Error(
      'Microphone access requires HTTPS or localhost. Open the demo at http://127.0.0.1:5173 on this computer.',
    )
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    })
    const tracks = stream.getAudioTracks()
    stream.getTracks().forEach(track => track.stop())
    if (!tracks.length) throw new DOMException('No microphone', 'NotFoundError')
  } catch (error) {
    throw new Error(microphoneMessage(error))
  }
}
