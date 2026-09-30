import * as React from "react";

import { IconProps } from "./types";

function Duplicate(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M7.5 12.5C7.5 10.143 7.5 8.96447 8.23223 8.23223C8.96447 7.5 10.143 7.5 12.5 7.5L13.3333 7.5C15.6904 7.5 16.8689 7.5 17.6011 8.23223C18.3333 8.96447 18.3333 10.143 18.3333 12.5V13.3333C18.3333 15.6904 18.3333 16.8689 17.6011 17.6011C16.8689 18.3333 15.6904 18.3333 13.3333 18.3333H12.5C10.143 18.3333 8.96447 18.3333 8.23223 17.6011C7.5 16.8689 7.5 15.6904 7.5 13.3333L7.5 12.5Z"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.1659 7.49984C14.164 5.03559 14.1266 3.75918 13.4094 2.88519C13.2709 2.71641 13.1161 2.56165 12.9473 2.42314C12.0254 1.6665 10.6556 1.6665 7.91602 1.6665C5.17645 1.6665 3.80666 1.6665 2.88471 2.42314C2.71592 2.56165 2.56116 2.71641 2.42265 2.88519C1.66602 3.80715 1.66602 5.17694 1.66602 7.9165C1.66602 10.6561 1.66602 12.0259 2.42265 12.9478C2.56116 13.1166 2.71592 13.2714 2.8847 13.4099C3.75869 14.1271 5.03511 14.1645 7.49935 14.1664"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoDuplicate = React.memo(Duplicate);
export default MemoDuplicate;
