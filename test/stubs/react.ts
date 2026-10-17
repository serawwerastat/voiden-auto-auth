/**
 * Stand-in for React in tests. Voiden supplies the real React at runtime;
 * the tests only load components, they never render them.
 */
const notRendering = () => {
  throw new Error("React rendering is not available in tests");
};
export const useState = notRendering;
export const useEffect = notRendering;
export const useCallback = notRendering;
export const useMemo = notRendering;
export const useRef = notRendering;
export const jsx = notRendering;
export const jsxs = notRendering;
export const Fragment = "fragment";
export default { useState, useEffect, useCallback, useMemo, useRef };
