import * as React from "react";
import { IconProps } from "./types";

function IfcFileIcon(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 32 40" fill="none" {...props}>
      <path d="M0 4a4 4 0 014-4h16l12 12v24a4 4 0 01-4 4H4a4 4 0 01-4-4V4z" fill="#155EEF" />
      <path opacity={0.3} d="M20 0l12 12h-8a4 4 0 01-4-4V0z" fill="#fff" />
    </svg>
  );
}

const MemoIfcFileIcon = React.memo(IfcFileIcon);
export default MemoIfcFileIcon;
