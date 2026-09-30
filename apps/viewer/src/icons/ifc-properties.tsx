import * as React from "react";
import { IconProps } from "./types";

function IfcProperties(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 18 18" fill="none" {...props}>
      <path
        d="M1.083 9c0-3.732 0-5.598 1.16-6.757C3.401 1.083 5.267 1.083 9 1.083c3.732 0 5.598 0 6.757 1.16 1.16 1.16 1.16 3.025 1.16 6.757 0 3.732 0 5.598-1.16 6.758-1.16 1.159-3.025 1.159-6.757 1.159-3.732 0-5.598 0-6.758-1.16C1.083 14.598 1.083 12.732 1.083 9z"
        stroke="#C2CBDE"
        strokeWidth={1.5}
      />
      <path d="M1.083 5.667h15.833" stroke="#C2CBDE" strokeWidth={1.5} strokeLinejoin="round" />
      <path
        d="M8.166 13.167h5m-8.333 0h.833M8.166 9.834h5m-8.333 0h.833"
        stroke="#C2CBDE"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoIfcProperties = React.memo(IfcProperties);
export default MemoIfcProperties;
