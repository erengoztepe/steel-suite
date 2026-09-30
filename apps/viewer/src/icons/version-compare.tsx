import * as React from "react";

import { IconProps } from "./types";

function VersionCompare(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect x="1" y="3" width="8" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="3" width="8" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 7.5H5.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5 10H5.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5 12.5H5.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M15 7.5H15.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M15 10H15.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M15 12.5H15.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M9 10L11 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="1 2" />
    </svg>
  );
}

const MemoVersionCompare = React.memo(VersionCompare);
export default MemoVersionCompare;
