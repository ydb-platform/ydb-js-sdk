import test from "node:test";
import * as assert from "node:assert";

import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import { YDBError } from "@ydbjs/error";

test("YDBError", async (tc) => {
	await tc.test("single issue", async () => {
		const error = new YDBError(StatusIds_StatusCode.ABORTED, [{
			severity: 0,
			issueCode: 14,
			message: "Some error message",
		}]);

		assert.strictEqual(error.code, StatusIds_StatusCode.ABORTED);
		assert.strictEqual(error.message, "Status: 400040, Issues: FATAL 14: Some error message");
	});

	await tc.test("multiple issues", async () => {
		const error = new YDBError(StatusIds_StatusCode.ABORTED, [{
			severity: 0,
			issueCode: 14,
			message: "Some error message",
		}, {
			severity: 1,
			issueCode: 15,
			message: "Another error message",
		}]);

		assert.strictEqual(error.code, StatusIds_StatusCode.ABORTED);
		assert.strictEqual(error.message, "Status: 400040, Issues: FATAL 14: Some error message; ERROR 15: Another error message");
	});
})
