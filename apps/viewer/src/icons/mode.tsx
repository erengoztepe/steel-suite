import * as React from "react";
import { IconProps } from "./types";

function Mode(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M12.9173 5.41667C12.9173 7.0275 11.6115 8.33333 10.0007 8.33333C8.38982 8.33333 7.08398 7.0275 7.08398 5.41667C7.08398 3.80584 8.38982 2.5 10.0007 2.5C11.6115 2.5 12.9173 3.80584 12.9173 5.41667Z"
        stroke="white"
        strokeWidth="1.5"
      />
      <path
        d="M18.3333 14.5832C18.3333 16.194 17.0275 17.4998 15.4167 17.4998C13.8058 17.4998 12.5 16.194 12.5 14.5832C12.5 12.9723 13.8058 11.6665 15.4167 11.6665C17.0275 11.6665 18.3333 12.9723 18.3333 14.5832Z"
        stroke="white"
        strokeWidth="1.5"
      />
      <path
        d="M7.50033 14.5832C7.50033 16.194 6.19449 17.4998 4.58366 17.4998C2.97283 17.4998 1.66699 16.194 1.66699 14.5832C1.66699 12.9723 2.97283 11.6665 4.58366 11.6665C6.19449 11.6665 7.50033 12.9723 7.50033 14.5832Z"
        stroke="white"
        strokeWidth="1.5"
      />
    </svg>
  );
}

const MemoMode = React.memo(Mode);
export default MemoMode;
