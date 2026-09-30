import * as React from "react";
import { IconProps } from "./types";

function OutlinedEnter(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M13.3332 10.0003L6.6665 10.0003M13.3332 10.0003C13.3332 9.4168 11.6713 8.3266 11.2498 7.91699M13.3332 10.0003C13.3332 10.5838 11.6713 11.6741 11.2498 12.0837"
        stroke="#AFD8D4"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.0835 9.99967C2.0835 6.26772 2.0835 4.40175 3.24287 3.24238C4.40223 2.08301 6.26821 2.08301 10.0002 2.08301C13.7321 2.08301 15.5981 2.08301 16.7575 3.24238C17.9168 4.40175 17.9168 6.26772 17.9168 9.99967C17.9168 13.7316 17.9168 15.5976 16.7575 16.757C15.5981 17.9163 13.7321 17.9163 10.0002 17.9163C6.26821 17.9163 4.40223 17.9163 3.24287 16.757C2.0835 15.5976 2.0835 13.7316 2.0835 9.99967Z"
        stroke="#AFD8D4"
        strokeWidth="1.5"
      />
    </svg>
  );
}

const MemoOutlinedEnter = React.memo(OutlinedEnter);
export default MemoOutlinedEnter;
