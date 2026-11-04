import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VoicePanel } from './VoicePanel'
import './style.css'
import { requestPackProofAssertion } from './handoff'
function App() {
  const [invitation, setInvitation] = useState('')
  const getAssertion = useCallback(async () => {
    if (window.parent !== window)
      return requestPackProofAssertion(
        import.meta.env.VITE_PACKPROOF_ORIGIN ??
          'https://packproof-p0.vercel.app',
      )
    if (!invitation.trim())
      throw new Error(
        'Open voice from PackProof or enter an authorized demo invitation.',
      )
    return invitation.trim()
  }, [invitation])
  return (
    <main>
      <VoicePanel
        gatewayUrl={
          import.meta.env.VITE_VOICE_GATEWAY_URL ?? 'http://localhost:8080'
        }
        getAssertion={getAssertion}
        radioUrl={import.meta.env.VITE_RADIO_STREAM_URL}
      />
      <details>
        <summary>Authorized demo access</summary>
        <p>
          Demo invitations allow public lookups only. PackProof registration and
          sign-in remain on the PackProof website.
        </p>
        <label htmlFor="invitation">Short-lived invitation</label>
        <input
          id="invitation"
          type="password"
          autoComplete="off"
          value={invitation}
          onChange={e => setInvitation(e.target.value)}
        />
      </details>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
