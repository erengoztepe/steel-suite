import * as React from "react";
import { IconProps } from "./types";

function ParallelProjection(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M6.00954 9.32571V11.3172H1.34163C1.33795 11.3172 1.33496 11.3142 1.33496 11.3105V1.33968C1.33496 1.336 1.33795 1.33301 1.34163 1.33301H11.3263C11.33 1.33301 11.333 1.336 11.333 1.33968V5.97905H9.33522M7.99261 5.97891H5.98626C5.98257 5.97891 5.97959 5.9819 5.97959 5.98558V8.00223M12.652 14.6661H14.6584C14.6621 14.6661 14.6651 14.6631 14.6651 14.6594V12.6428M14.6612 9.33509V11.3338M11.3212 14.6596H9.33441M7.99261 14.6663H5.98626C5.98257 14.6663 5.97959 14.6634 5.97959 14.6597V13.3247M13.3211 5.99756H14.6584C14.6621 5.99756 14.6651 6.00055 14.6651 6.00423V7.99838"
        stroke="white"
        strokeWidth="1.5"
      />
    </svg>
  );
}

const MemoParallelProjection = React.memo(ParallelProjection);
export default MemoParallelProjection;
