// @ts-nocheck
/**
 * Wrapper for swagger-ui-react v5 which has incorrect TypeScript types.
 * The component type is declared as (props: {}) — accepting NO props —
 * but at runtime it accepts spec, docExpansion, filter, etc.
 * This wrapper silences the TS error while passing all props through.
 */
import SwaggerUIBase from "swagger-ui-react";

export default SwaggerUIBase;
