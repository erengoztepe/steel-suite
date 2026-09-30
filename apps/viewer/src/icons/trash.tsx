import * as React from "react";
import { IconProps } from "./types";

function Trash(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M13 3.6665L12.5868 10.3499C12.4813 12.0575 12.4285 12.9113 12.0005 13.5251C11.7889 13.8286 11.5164 14.0847 11.2005 14.2772C10.5614 14.6665 9.70599 14.6665 7.99516 14.6665C6.28208 14.6665 5.42554 14.6665 4.78604 14.2765C4.46987 14.0836 4.19733 13.827 3.98579 13.5231C3.55792 12.9082 3.5063 12.0532 3.40307 10.3433L3 3.6665"
        stroke="white"
        strokeOpacity="0.8"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M2 3.66683H14M10.7038 3.66683L10.2487 2.72798C9.94638 2.10433 9.79522 1.79251 9.53448 1.59803C9.47664 1.5549 9.4154 1.51652 9.35135 1.4833C9.06261 1.3335 8.71608 1.3335 8.02302 1.3335C7.31255 1.3335 6.95732 1.3335 6.66379 1.48958C6.59873 1.52417 6.53666 1.56409 6.4782 1.60894C6.21443 1.8113 6.06709 2.13453 5.7724 2.781L5.36862 3.66683"
        stroke="white"
        strokeOpacity="0.8"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

const MemoTrash = React.memo(Trash);
export default MemoTrash;
