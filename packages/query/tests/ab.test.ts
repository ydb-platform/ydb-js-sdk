async function testWithRace() {
	// Create a slow generator similar to the previous test
	const slowGenerator = () => ({
		[Symbol.asyncIterator]() {
			let yielded = false;
			console.log('Generator started');

			return {
				// async next() {
				//     if (!yielded) {
				//         await new Promise(resolve => setTimeout(resolve, 5000));
				//         yielded = true;
				//         console.log('Generator yielded first value');
				//         return { value: { status: 200 }, done: false };
				//     }
				//     return { value: undefined, done: true };
				// },
				async return() {
					return { value: undefined, done: true };
				},
				async throw(error) {
					if (this._abortController) {
						this._abortController.abort();
					}
					throw error;
				},
				_abortController: (null as unknown) as AbortController, // Initialize abort controller
				async next() {
					if (!yielded) {
						this._abortController = new AbortController();
						try {
							await new Promise((resolve, reject) => {
								const timeout = setTimeout(resolve, 5000);
								this._abortController.signal.addEventListener('abort', () => {
									clearTimeout(timeout);
									reject(new Error('Operation aborted'));
								});
							});
							yielded = true;
							console.log('Generator yielded first value');
							return { value: { status: 200 }, done: false };
						} catch (err) {
							if (err.message === 'Operation aborted') {
								throw error; // Re-throw the original error from throw()
							}
							throw err;
						}
					}
					return { value: undefined, done: true };
				}
			};
		}
	});

	// Create the iterator
	const iterator = slowGenerator()[Symbol.asyncIterator]()

	const timeout = 2000 // 2 seconds timeout

	try {
		// Race between the iterator's next result and a timeout promise
		const result = await Promise.race([
			iterator.next(),
			new Promise((_, reject) =>
				setTimeout(() => iterator.throw!(new Error("Operation timed out after " + timeout + "ms")), timeout)
			)
		])

		console.log('Result:', result)
		return result
	} catch (error) {
		console.error('Error occurred:', error.message)
		throw error
	}
}

// Run the improved test
testWithRace().catch(err => console.error('Test failed with race pattern:', err))
