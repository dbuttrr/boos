let watchId = null;
let lastPosition = null;
let startPromise = null;
const listeners = new Set();

const GEO_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 15_000,
  timeout: 15_000,
};

function notify(position) {
  lastPosition = position;
  for (const listener of listeners) {
    listener(position);
  }
}

function coordsFromPosition(pos) {
  return {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy: pos.coords.accuracy,
  };
}

function clearWatch() {
  if (watchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
}

function startWatch() {
  if (!navigator.geolocation || watchId !== null) return;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      notify(coordsFromPosition(pos));
    },
    () => {
      // Allow a later startGeolocation() call to retry
      clearWatch();
    },
    GEO_OPTIONS
  );
}

/**
 * Start locating the user. Safe to call multiple times.
 * Returns a promise that resolves with the first fix (or null on failure).
 * Retries after a previous failure.
 */
export function startGeolocation() {
  if (!navigator.geolocation) {
    return Promise.resolve(null);
  }

  if (lastPosition && watchId !== null) {
    return Promise.resolve(lastPosition);
  }

  if (startPromise) {
    return startPromise;
  }

  startPromise = new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next = coordsFromPosition(pos);
        notify(next);
        startWatch();
        startPromise = null;
        resolve(next);
      },
      () => {
        clearWatch();
        // Still try watching — some browsers succeed on watch after getCurrent fails
        startWatch();
        startPromise = null;
        resolve(lastPosition);
      },
      GEO_OPTIONS
    );
  });

  return startPromise;
}

export function stopGeolocation() {
  clearWatch();
  startPromise = null;
}

export function getLastPosition() {
  return lastPosition;
}

export function onPositionChange(listener) {
  listeners.add(listener);
  if (lastPosition) listener(lastPosition);
  return () => listeners.delete(listener);
}
