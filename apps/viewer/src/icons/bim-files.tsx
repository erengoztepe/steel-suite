import * as React from "react";
import { IconProps } from "./types";

function BimFiles(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 20 20" fill="none" {...props}>
      <path
        d="M16.758 3.243c1.159 1.16 1.159 3.025 1.159 6.757 0 3.732 0 5.598-1.16 6.758-1.159 1.159-3.025 1.159-6.757 1.159-3.732 0-5.598 0-6.757-1.16-1.16-1.159-1.16-3.025-1.16-6.757 0-3.732 0-5.598 1.16-6.757 1.16-1.16 3.025-1.16 6.757-1.16 3.732 0 5.598 0 6.758 1.16z"
        stroke="#C2CBDE"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M17.917 12.5H2.084" stroke="#C2CBDE" strokeWidth={1.5} />
    </svg>
  );
}

const MemoBimFiles = React.memo(BimFiles);
export default MemoBimFiles;
