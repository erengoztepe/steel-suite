import * as React from "react";
import { IconProps } from "./types";

function AlertCircle(props: IconProps) {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M1.66797 16C1.66797 8.08388 8.08522 1.66663 16.0013 1.66663C23.9174 1.66663 30.3346 8.08388 30.3346 16C30.3346 23.916 23.9174 30.3333 16.0013 30.3333C8.08522 30.3333 1.66797 23.916 1.66797 16Z"
        fill="rgb(var(--status-error-light))"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14.668 21.9712C14.668 21.124 15.3517 20.4372 16.1951 20.4372H16.2088C17.0522 20.4372 17.736 21.124 17.736 21.9712C17.736 22.8184 17.0522 23.5052 16.2088 23.5052H16.1951C15.3517 23.5052 14.668 22.8184 14.668 21.9712Z"
        fill="#141B34"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M16.202 17.3692C15.3548 17.3692 14.668 16.6824 14.668 15.8352L14.668 9.69916C14.668 8.85196 15.3548 8.16516 16.202 8.16516C17.0492 8.16516 17.736 8.85196 17.736 9.69916L17.736 15.8352C17.736 16.6824 17.0492 17.3692 16.202 17.3692Z"
        fill="#141B34"
      />
    </svg>
  );
}

const AlertCircleCursor = React.memo(AlertCircle);
export default AlertCircleCursor;
