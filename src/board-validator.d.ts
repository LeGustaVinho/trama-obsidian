import type { ValidateFunction } from "ajv";
import type { Board } from "./board";

declare const validateShape: ValidateFunction<Board>;
export default validateShape;
