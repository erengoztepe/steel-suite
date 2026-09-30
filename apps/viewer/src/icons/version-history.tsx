import * as React from "react";
import { IconProps } from "./types";

function VersionHistory(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 20 20" fill="none" {...props}>
      <path
        d="M1.667 13.333c0-1.949 0-2.923.447-3.635.233-.37.547-.684.918-.918.711-.447 1.686-.447 3.635-.447h6.666c1.95 0 2.924 0 3.635.447.371.234.685.547.918.918.447.712.447 1.686.447 3.635 0 1.95 0 2.924-.447 3.635a2.917 2.917 0 01-.918.918c-.711.447-1.686.447-3.635.447H6.667c-1.95 0-2.924 0-3.635-.447a2.916 2.916 0 01-.918-.918c-.447-.711-.447-1.686-.447-3.635zM16.667 8.333c0-1.166 0-1.75-.227-2.195-.2-.392-.519-.711-.91-.91C15.083 5 14.5 5 13.332 5H6.667C5.5 5 4.917 5 4.47 5.227c-.392.2-.71.519-.91.91-.228.446-.228 1.03-.228 2.196M15 5c0-1.571 0-2.357-.488-2.845s-1.274-.488-2.845-.488H8.333c-1.571 0-2.357 0-2.845.488S5 3.429 5 5"
        stroke="#DDECFF"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.5 11.667c0 .92-.746 1.666-1.667 1.666H9.167c-.92 0-1.667-.746-1.667-1.666"
        stroke="#DDECFF"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </svg>
  );
}

const MemoVersionHistory = React.memo(VersionHistory);
export default MemoVersionHistory;
