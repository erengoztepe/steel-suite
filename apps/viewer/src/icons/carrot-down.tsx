import * as React from "react";
import { IconProps } from "./types";

function CarrotDown(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 10 6" fill="currentColor" {...props}>
      <path d="M9.395.463c.297.219.36.636.142.932a35.477 35.477 0 01-1.638 2.042c-.442.509-.931 1.034-1.388 1.438a4.92 4.92 0 01-.693.524c-.21.127-.5.268-.818.268-.318 0-.608-.14-.819-.268a4.92 4.92 0 01-.692-.524c-.457-.404-.947-.93-1.388-1.438A35.476 35.476 0 01.463 1.395.667.667 0 011 .333h8c.137 0 .276.043.395.13z" />
    </svg>
  );
}

const MemoCarrotDown = React.memo(CarrotDown);
export default MemoCarrotDown;
