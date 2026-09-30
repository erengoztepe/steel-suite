import * as React from "react";
import { IconProps } from "./types";

function ComplianceCheck(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 20 20" fill="none" {...props}>
      <path
        d="M17.5 9.167v-.834c0-3.142 0-4.714-1.034-5.69s-2.697-.976-6.025-.976H9.56c-3.328 0-4.992 0-6.025.976C2.5 3.619 2.5 5.19 2.5 8.333v3.334c0 3.142 0 4.714 1.034 5.69 1.033.976 2.697.976 6.025.976H10M6.667 5.833h6.666M6.667 9.167h4.166M6.667 12.5h1.666"
        stroke="#DDECFF"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      <path
        d="M19.115 15.903c-.169.64-.964 1.091-2.555 1.995-1.538.874-2.307 1.31-2.927 1.135a1.549 1.549 0 01-.678-.4c-.455-.46-.455-1.35-.455-3.133 0-1.782 0-2.673.455-3.133.189-.19.422-.328.678-.4.62-.176 1.389.261 2.927 1.135 1.59.904 2.386 1.356 2.555 1.995.069.264.069.542 0 .806z"
        stroke="#DDECFF"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoComplianceCheck = React.memo(ComplianceCheck);
export default MemoComplianceCheck;
