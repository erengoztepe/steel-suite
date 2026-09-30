import type { IconProps } from "./types";

const MemberVectors = ({ className, width = 24, height = 24, ...props }: IconProps) => (
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
    {/* Node */}
    <circle cx="5" cy="19" r="1.6" />
    {/* Two member vectors radiating from the node */}
    <path d="M6 18 L19 9" />
    <path d="M16.5 9 L19 9 L19 11.5" />
    <path d="M6 18 L14 6" />
    <path d="M12 6.5 L14 6 L14.5 8" />
  </svg>
);

export default MemberVectors;
