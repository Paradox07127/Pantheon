import { useEffect, useState } from 'react';

/** True once `active` has stayed true for `ms`; false again as soon as it ends. */
export function useDelayed(active: boolean, ms = 300): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) {
      setLate(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && late;
}
