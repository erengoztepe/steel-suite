import * as React from "react";
import { IconProps } from "./types";

function NotificationBell(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 18 20" fill="none" {...props}>
      <path d="M12.333 15a3.333 3.333 0 01-6.667 0" stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" />
      <path
        d="M15.281 10.336V7.91a6.247 6.247 0 00-6.25-6.244A6.247 6.247 0 002.78 7.912v2.424l-1.656 2.858a.096.096 0 00.015.12c2.429 2.272 10.436 4.282 15.712-.017a.1.1 0 00.024-.126l-1.594-2.835z"
        stroke="#fff"
        strokeWidth={1.5}
      />
    </svg>
  );
}

const MemoNotificationBell = React.memo(NotificationBell);
export default MemoNotificationBell;
