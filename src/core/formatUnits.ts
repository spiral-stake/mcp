import BigNumber from "bignumber.js";
import { formatUnits as formatUnitsWagmi, parseUnits as parseUnitsWagmi } from "viem";

export const formatUnits = (value: bigint, decimals = 18) => {
  return new BigNumber(formatUnitsWagmi(value, decimals));
};

export const parseUnits = (value: string, decimals = 18) => {
  return parseUnitsWagmi(value, decimals);
};
