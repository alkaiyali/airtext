import { LockIcon } from './icons'

interface TrustStepsProps {
  /** Compact drops the "connect" step: the user is already on that screen. */
  compact?: boolean
}

/**
 * The match check, previewed before pairing. The pairing screens used to only
 * assert privacy ("end-to-end encrypted"); this states the mechanism the user
 * will perform: both screens show the same code, sharing stays locked until
 * each side confirms it, and a mismatch means leaving and starting over.
 */
export function TrustSteps({ compact = false }: TrustStepsProps) {
  if (compact) {
    return (
      <section className="trust-steps trust-compact" aria-label="What happens next">
        <h2><LockIcon size={14} /> After joining: compare the match code</h2>
        <ol>
          <li>
            <span className="step-num" aria-hidden="true">1</span>
            <span><strong>Both screens show the same match code.</strong> Confirm it on each screen to unlock sharing.</span>
          </li>
          <li>
            <span className="step-num" aria-hidden="true">2</span>
            <span><strong>Text is sealed on your device,</strong> never stored on the server. Codes differ? Leave and start over.</span>
          </li>
        </ol>
      </section>
    )
  }
  return (
    <section className="trust-steps" aria-labelledby="trust-title">
      <h2 id="trust-title"><LockIcon size={14} /> How you know it&apos;s private</h2>
      <ol>
        <li>
          <span className="step-num" aria-hidden="true">1</span>
          <span><strong>Connect with QR or code.</strong> No account, no install — rooms are temporary.</span>
        </li>
        <li>
          <span className="step-num" aria-hidden="true">2</span>
          <span><strong>Both screens show the same match code.</strong> Confirm it on each screen to unlock sharing.</span>
        </li>
        <li>
          <span className="step-num" aria-hidden="true">3</span>
          <span><strong>Text is sealed on your device,</strong> never stored on the server. Codes differ? Leave and start over.</span>
        </li>
      </ol>
    </section>
  )
}
