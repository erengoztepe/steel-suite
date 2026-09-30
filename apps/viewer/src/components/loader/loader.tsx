import { LoaderProps } from "./types";
import styles from "./style.module.css";

const Loader = ({ className }: LoaderProps) => {
  return <span className={`${styles.loader} ${className ? className : " w-12 h-12"}`}></span>;
};

export default Loader;
