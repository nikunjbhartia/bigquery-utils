import ModuleFactory from "../compiled/tuple_sketch.mjs";

var Module = await ModuleFactory();

// Helper definitions

// shared buffer for serialization and deserialization
var BUFFER = {
  ptr: 0,
  size: 0,
};

function maxSize(lg_k) {
  // see https://datasketches.apache.org/docs/Theta/ThetaSize.html
  // Todo: Calculate max size for tuple sketches ( couldn't find documentation)
  // using 16 bytes per row throws "error writing to std::ostream with 1 items"
  // 16 bytes per entry was calculated for theta sketch, since tuple sketch has an additional summary row of input datatype,
  // doubling the size requirement as max bound
  return 8 + 24 + 32 * (1 << lg_k);
}
function requireBuffer(size) {
  if (BUFFER.size < size) {
    releaseBuffer();
    BUFFER.ptr = Module._malloc(size);
    BUFFER.size = size;
  }
  return BUFFER;
}

function releaseBuffer() {
  if (BUFFER.ptr) {
    Module._free(BUFFER.ptr);
  }
  BUFFER.ptr = 0;
  BUFFER.size = 0;
}

function destroyState(state) {
  if (state.sketch) {
    Module._update_sketch_destroy(state.sketch);
    state.sketch = 0;
  }
  if (state.union) {
    Module._tuple_union_destroy(state.union);
    state.union = 0;
  }
  state.serialized = null;
}

function updateUnion(union, bytes) {
  var buffer = requireBuffer(bytes.length);
  Module.HEAPU8.subarray(buffer.ptr, buffer.ptr + buffer.size).set(bytes);
  Module._tuple_union_update_buffer(union, buffer.ptr, bytes.length);
}

// UDAF interface

export function initialState(lg_k) {
  lg_k = Module._clamp_lg_k(lg_k);
  return {
    sketch: Module._update_sketch_initialize(lg_k),
    lg_k: lg_k,
    serialized: null,
    union: 0,
  };
}

export function aggregate(state, key, value) {
  if (!state.sketch) {
    state.sketch = Module._update_sketch_initialize(state.lg_k);
  }

  Module._tuple_sketch_update_int64(state.sketch, key, value);
}

export function serialize(state) {
  var buffer = requireBuffer(maxSize(state.lg_k));
  var len = 0;
  try {
    if (state.sketch && state.serialized) {
      // merge aggregated and serialized state
      Module.HEAPU8
        .subarray(buffer.ptr, buffer.ptr + buffer.size)
        .set(state.serialized);

      len = Module._tuple_combined_update_serialized(
          buffer.ptr, buffer.size, state.serialized.length,
          state.sketch, state.lg_k);
    } else if (state.sketch) {
      len = Module._update_sketch_serialize(
          state.sketch, buffer.ptr, buffer.size);
    } else if (state.union) {
      len = Module._tuple_union_serialize_sketch(
          state.union, buffer.ptr, buffer.size);
    } else if (state.serialized) {
      return {
        lg_k: state.lg_k,
        bytes: state.serialized,
      }
    } else {
      throw new Error(
          "Unexpected state in serialization " + JSON.stringify(state));
    }
    return {
      lg_k: state.lg_k,
      bytes: Module.HEAPU8.slice(buffer.ptr , buffer.ptr + len),
    };
  } finally {
    destroyState(state);
  }
}

export function deserialize(serialized) {
  return {
    sketch: 0,
    union: 0,
    serialized: serialized.bytes,
    lg_k: serialized.lg_k,
  };
}

export function merge(state, other_state) {
  if (!state.union) {
    state.union = Module._tuple_union_initialize(state.lg_k);
  }

  if (state.sketch || other_state.sketch) {
    throw new Error("update_sketch not expected during merge()");
  }

  if (other_state.union) {
    throw new Error("other_state should not have union during merge()");
  }

  if (state.serialized) {
    // consume it
    updateUnion(state.union, state.serialized);
    state.serialized = null;
  }

  if (other_state.serialized) {
    updateUnion(state.union, other_state.serialized);
    other_state.serialized = null;
  } else {
    throw new Error("Expected serialized sketch on other_state");
  }
}

export function finalize(state) {
  var result = serialize(state);
  return result.bytes;
}