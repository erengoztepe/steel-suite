import * as React from "react";

import { IconProps } from "./types";

function Compare3DWith2D(props: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M1.6775 12.4895C0.75 11.562 0.75 10.0692 0.75 7.08366C0.75 4.0981 0.75 2.60532 1.67749 1.67782C2.60499 0.750326 4.09777 0.750326 7.08333 0.750325C10.0689 0.750325 11.5617 0.750325 12.4892 1.67782C13.4167 2.60532 13.4167 4.0981 13.4167 7.08366C13.4167 10.0692 13.4167 11.562 12.4892 12.4895C11.5617 13.417 10.0689 13.417 7.08333 13.417C4.09777 13.417 2.60499 13.417 1.6775 12.4895Z"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M0.75 5.08398L13.4167 5.08398" stroke="white" strokeWidth="1.5" />
      <path d="M4.41797 13.417L4.41797 5.08366" stroke="white" strokeWidth="1.5" />
    </svg>
  );
}

const MemoCompare3DWith2D = React.memo(Compare3DWith2D);
export default MemoCompare3DWith2D;
