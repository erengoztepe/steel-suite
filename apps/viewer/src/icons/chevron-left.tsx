import * as React from "react";
import { IconProps } from "./types";

function ChevronLeft(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.4721 3.52851C10.7324 3.78886 10.7324 4.21097 10.4721 4.47132L6.94346 7.99992L10.4721 11.5285C10.7324 11.7889 10.7324 12.211 10.4721 12.4713C10.2117 12.7317 9.7896 12.7317 9.52925 12.4713L5.52925 8.47132C5.2689 8.21097 5.2689 7.78886 5.52925 7.52851L9.52925 3.52851C9.7896 3.26816 10.2117 3.26816 10.4721 3.52851Z"
        fill="white"
      />
    </svg>
  );
}

const MemoChevronLeft = React.memo(ChevronLeft);
export default MemoChevronLeft;
