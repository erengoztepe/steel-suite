import * as React from "react";
import { IconProps } from "./types";

function Mechanical(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" {...props}>
      <path
        d="M16.9654 11.1303C15.9742 12.1213 14.1091 12.0828 11.2494 12.0828C9.4096 12.0828 7.9179 10.5889 7.91695 8.74912C7.91695 5.89135 7.87841 4.02522 8.86963 3.03416C9.86085 2.04311 10.2986 2.08323 14.6896 2.08323C15.1139 2.08142 15.3275 2.59458 15.0275 2.89463L12.7666 5.15562C12.1928 5.72953 12.1912 6.65995 12.7651 7.23378C13.3391 7.80761 14.2696 7.80767 14.8436 7.23391L17.105 4.97347C17.4051 4.6735 17.9183 4.88703 17.9165 5.3113C17.9165 9.70152 17.9566 10.1392 16.9654 11.1303Z"
        stroke="white"
        strokeWidth="1.5"
      />
      <path
        d="M11.2499 12.0833L6.10694 17.2263C5.18646 18.1468 3.69408 18.1468 2.77361 17.2263C1.85313 16.3058 1.85313 14.8135 2.77361 13.893L7.91659 8.75"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M4.59072 15.417H4.58325" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MemoMechanical = React.memo(Mechanical);
export default MemoMechanical;
