import * as React from "react";
import { IconProps } from "./types";

function Overwrite(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M10.8096 3.32159L11.7441 2.38709C12.2602 1.87097 13.097 1.87097 13.6131 2.38709C14.1292 2.9032 14.1292 3.73999 13.6131 4.2561L12.6786 5.19061M10.8096 3.32159L7.32031 6.81084C6.62345 7.5077 6.27501 7.85614 6.03774 8.28074C5.80048 8.70534 5.56176 9.70794 5.3335 10.6667C6.29222 10.4384 7.29482 10.1997 7.71942 9.96242C8.14402 9.72516 8.49246 9.37672 9.18933 8.67985L12.6786 5.19061M10.8096 3.32159L12.6786 5.19061"
        stroke="white"
        strokeOpacity="0.6"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 8C14 10.8284 14 12.2426 13.1213 13.1213C12.2426 14 10.8284 14 8 14C5.17157 14 3.75736 14 2.87868 13.1213C2 12.2426 2 10.8284 2 8C2 5.17157 2 3.75736 2.87868 2.87868C3.75736 2 5.17157 2 8 2"
        stroke="white"
        strokeOpacity="0.6"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

const MemoOverwrite = React.memo(Overwrite);
export default MemoOverwrite;
