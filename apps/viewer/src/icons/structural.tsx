import * as React from "react";
import { IconProps } from "./types";

function Structural(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" {...props}>
      <path
        d="M1.66675 14.583H6.66675M6.66675 17.083H1.66675"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.3333 14.583H18.3333M18.3333 17.083H13.3333"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.25 10H8.75V13.3333H11.25V10Z"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.1666 5.83366C14.1666 8.13485 12.3011 10.0003 9.99992 10.0003C7.69873 10.0003 5.83325 8.13485 5.83325 5.83366C5.83325 3.53247 7.69873 1.66699 9.99992 1.66699C12.3011 1.66699 14.1666 3.53247 14.1666 5.83366Z"
        stroke="white"
        strokeWidth="1.5"
      />
      <path
        d="M10 5.83301L11.25 4.58301"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.6667 13.333H8.33341C7.54774 13.333 7.1549 13.333 6.91083 13.5771C6.66675 13.8212 6.66675 14.214 6.66675 14.9997V16.6663C6.66675 17.452 6.66675 17.8449 6.91083 18.0889C7.1549 18.333 7.54774 18.333 8.33341 18.333H11.6667C12.4524 18.333 12.8453 18.333 13.0893 18.0889C13.3334 17.8449 13.3334 17.452 13.3334 16.6663V14.9997C13.3334 14.214 13.3334 13.8212 13.0893 13.5771C12.8453 13.333 12.4524 13.333 11.6667 13.333Z"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoStructural = React.memo(Structural);
export default MemoStructural;
