import * as React from "react";
import { IconProps } from "./types";

function Ruler(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M14.5833 8.75L16.25 10.4167M11.6667 11.6667L13.3333 13.3333M8.75 14.5833L10.4167 16.25"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M8.77994 3.8979C9.9172 2.76064 10.4858 2.19201 11.1202 1.92926C11.9659 1.57892 12.9163 1.57892 13.762 1.92926C14.3964 2.19201 14.965 2.76064 16.1023 3.8979C17.2395 5.03515 17.8082 5.60378 18.0709 6.23812C18.4212 7.0839 18.4212 8.03422 18.0709 8.88C17.8082 9.51434 17.2395 10.083 16.1023 11.2202L11.2207 16.1018C10.0835 17.239 9.51483 17.8077 8.88049 18.0704C8.03471 18.4208 7.08439 18.4208 6.23861 18.0704C5.60427 17.8077 5.03564 17.239 3.89838 16.1018C2.76112 14.9645 2.19249 14.3959 1.92974 13.7616C1.57941 12.9158 1.57941 11.9655 1.92974 11.1197C2.19249 10.4853 2.76112 9.91671 3.89838 8.77945L8.77994 3.8979Z"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoRuler = React.memo(Ruler);
export default MemoRuler;
