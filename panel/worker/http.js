// Throw from an API handler to answer with this HTTP status and { error: message }
export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
