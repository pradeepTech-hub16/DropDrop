import { Link } from 'react-router-dom'

export function LogoMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#22262b" stroke="#343a41" />
      <path d="M16 5c4 5.5 7 9 7 12.5a7 7 0 0 1-14 0C9 14 12 10.5 16 5z" fill="#3ddc97" />
      <path d="M12.5 18l2.5 2.5 4.5-5" fill="none" stroke="#1a1d21" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function Logo({ size = 28, className = '' }) {
  return (
    <Link to="/" className={`inline-flex items-center gap-2.5 ${className}`} aria-label="DropDrop home">
      <LogoMark size={size} />
      <span className="text-lg font-semibold tracking-tight">
        Drop<span className="text-mint">Drop</span>
      </span>
    </Link>
  )
}
