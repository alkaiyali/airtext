import type { DeviceKind } from '../types'
import { ChevronRightIcon, ComputerIcon, LockIcon, PhoneIcon } from './icons'
import { TrustSteps } from './TrustSteps'

interface ModeChooserProps {
  preferred: DeviceKind
  onChoose: (device: DeviceKind) => void
}

export function ModeChooser({ preferred, onChoose }: ModeChooserProps) {
  return (
    <section className="screen mode-chooser" aria-labelledby="mode-title">
      <h1 id="mode-title">Move text between your screens.</h1>
      <p className="lede">Open airtext on your computer and phone, scan once, and share both ways. No app, no account.</p>
      <div className="option-list" role="group" aria-label="Choose your device">
        <button className="option" type="button" onClick={() => onChoose('desktop')}>
          <span className="option-icon" aria-hidden="true"><ComputerIcon size={20} /></span>
          <span className="option-text"><strong>Use this computer</strong><small>Shows a QR code to scan</small></span>
          {preferred === 'desktop' ? <span className="option-badge">Recommended</span> : null}
          <span className="option-arrow" aria-hidden="true"><ChevronRightIcon size={18} /></span>
        </button>
        <button className="option" type="button" onClick={() => onChoose('phone')}>
          <span className="option-icon" aria-hidden="true"><PhoneIcon size={20} /></span>
          <span className="option-text"><strong>Use this phone</strong><small>Scan or type a code</small></span>
          {preferred === 'phone' ? <span className="option-badge">Recommended</span> : null}
          <span className="option-arrow" aria-hidden="true"><ChevronRightIcon size={18} /></span>
        </button>
      </div>
      <p className="trust-line">
        <span><LockIcon size={13} /> End-to-end encrypted</span>
        <span>No account</span>
        <span>Nothing stored on a server</span>
      </p>
      <TrustSteps />
    </section>
  )
}
