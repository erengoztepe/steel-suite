import * as React from "react";
import { IconProps } from "./types";

function Electrical(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" {...props}>
      <path
        d="M5.16126 9.49708L10.16 2.75988C10.551 2.23298 11.2837 2.56093 11.2837 3.2628V8.47746C11.2837 8.89789 11.5711 9.23873 11.9256 9.23873H14.3569C14.9092 9.23873 15.2036 10.0112 14.8387 10.5029L9.83999 17.2401C9.44905 17.767 8.71628 17.4391 8.71628 16.7372V11.5225C8.71628 11.1021 8.42891 10.7613 8.07443 10.7613H5.64311C5.0908 10.7613 4.79638 9.98885 5.16126 9.49708Z"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoElectrical = React.memo(Electrical);
export default MemoElectrical;
