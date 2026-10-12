import type { DeviceKind } from '../types'
import { CheckIcon, ChevronRightIcon, ComputerIcon, LockIcon, PhoneIcon } from './icons'

interface ModeChooserProps {
  preferred: DeviceKind
  onChoose: (device: DeviceKind) => void
}

export function ModeChooser({ preferred, onChoose }: ModeChooserProps) {
  return (
    <section className="mode-chooser" aria-labelledby="mode-title">
      <div>
        <p className="eyebrow">One clipboard, two screens</p>
        <h1 id="mode-title">Move text without emailing it to yourself.</h1>
        <p className="lede">Open airtext on your computer and your phone, scan once, and anything you share shows up on both. Nothing to install, nothing to sign into.</p>
      </div>
      <div className="mode-panel">
        <div className="mode-options" role="group" aria-label="Choose your device">
          <button className="mode-option" type="button" onClick={() => onChoose('desktop')}>
            <span className="mode-icon" aria-hidden="true"><ComputerIcon /></span>
            <span><strong>Use this computer</strong><small>{preferred === 'desktop' ? 'Recommended · shows a QR code' : 'Shows a QR code to scan'}</small></span>
            <span className="mode-arrow" aria-hidden="true"><ChevronRightIcon /></span>
          </button>
          <button className="mode-option" type="button" onClick={() => onChoose('phone')}>
            <span className="mode-icon" aria-hidden="true"><PhoneIcon /></span>
            <span><strong>Use this phone</strong><small>{preferred === 'phone' ? 'Recommended · scan or type a code' : 'Scan or type a code'}</small></span>
            <span className="mode-arrow" aria-hidden="true"><ChevronRightIcon /></span>
          </button>
        </div>
        <ul className="trust-list" aria-label="Privacy">
          <li><span aria-hidden="true"><LockIcon /></span> End-to-end encrypted on your devices</li>
          <li><span aria-hidden="true"><CheckIcon size={15} /></span> No account, no app to install</li>
          <li><span aria-hidden="true"><CheckIcon size={15} /></span> Your text is never stored on a server</li>
        </ul>
      </div>
    </section>
  )
}
