import type { IconProps } from "./types";

const WalkMode = ({ className, width = 24, height = 24, ...props }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    {/* Head */}
    <circle cx="12" cy="4.5" r="2" />
    {/* Body */}
    <path d="M12 7v5" />
    {/* Left leg - stepping */}
    <path d="M9 20l1.5-5L12 12" />
    {/* Right leg - stepping */}
    <path d="M15 20l-1.5-5L12 12" />
    {/* Left arm swinging */}
    <path d="M8 14l2-4.5" />
    {/* Right arm swinging */}
    <path d="M16 14l-2-4.5" />
  </svg>
);

export default WalkMode;
