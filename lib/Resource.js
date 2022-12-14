import stream from "node:stream";
import clone from "clone";
import path from "node:path";

const fnTrue = () => true;
const fnFalse = () => false;

/**
 * Resource
 *
 * @public
 * @class
 * @alias @ui5/fs/Resource
 */
class Resource {
	/**
	* Function for dynamic creation of content streams
	*
	* @public
	* @callback @ui5/fs/Resource~createStream
	* @returns {stream.Readable} A readable stream of a resources content
	*/

	/**
	 * The constructor.
	 *
	 * @public
	 * @param {object} parameters Parameters
	 * @param {string} parameters.path Virtual path
	 * @param {fs.Stats|object} [parameters.statInfo] File information. Instance of
	 *					[fs.Stats]{@link https://nodejs.org/api/fs.html#fs_class_fs_stats} or similar object
	 * @param {Buffer} [parameters.buffer] Content of this resources as a Buffer instance
	 *					(cannot be used in conjunction with parameters string, stream or createStream)
	 * @param {string} [parameters.string] Content of this resources as a string
	 *					(cannot be used in conjunction with parameters buffer, stream or createStream)
	 * @param {Stream} [parameters.stream] Readable stream of the content of this resource
	 *					(cannot be used in conjunction with parameters buffer, string or createStream)
	 * @param {@ui5/fs/Resource~createStream} [parameters.createStream] Function callback that returns a readable
	 *					stream of the content of this resource (cannot be used in conjunction with parameters buffer,
	 *					string or stream).
	 *					In some cases this is the most memory-efficient way to supply resource content
	 * @param {@ui5/project/specifications/Project} [parameters.project] Project this resource is associated with
	 * @param {object} [parameters.source] Experimental, internal parameter. Do not use
	 */
	constructor({path, statInfo, buffer, string, createStream, stream, project, source}) {
		if (!path) {
			throw new Error("Cannot create Resource: path parameter missing");
		}
		if (buffer && createStream || buffer && string || string && createStream || buffer && stream ||
				string && stream || createStream && stream) {
			throw new Error("Cannot create Resource: Please set only one content parameter. " +
				"Buffer, string, stream or createStream");
		}

		this._path = path;
		this._name = Resource._getNameFromPath(path);

		this._source = source; // Experimental, internal parameter
		if (this._source) {
			// Indicator for adapters like FileSystem to detect whether a resource has been changed
			this._source.modified = false;
		}
		this.__project = project; // Two underscores since "_project" was widely used in UI5 Tooling 2.0

		this._statInfo = statInfo || { // TODO
			isFile: fnTrue,
			isDirectory: fnFalse,
			isBlockDevice: fnFalse,
			isCharacterDevice: fnFalse,
			isSymbolicLink: fnFalse,
			isFIFO: fnFalse,
			isSocket: fnFalse,
			atimeMs: new Date().getTime(),
			mtimeMs: new Date().getTime(),
			ctimeMs: new Date().getTime(),
			birthtimeMs: new Date().getTime(),
			atime: new Date(),
			mtime: new Date(),
			ctime: new Date(),
			birthtime: new Date()
		};

		if (createStream) {
			this._createStream = createStream;
		} else if (stream) {
			this._stream = stream;
		} else if (buffer) {
			this.setBuffer(buffer);
		} else if (typeof string === "string" || string instanceof String) {
			this.setString(string);
		}

		// Tracing:
		this._collections = [];
	}

	static _getNameFromPath(virPath) {
		return path.posix.basename(virPath);
	}

	/**
	 * Gets a buffer with the resource content.
	 *
	 * @public
	 * @returns {Promise<Buffer>} Promise resolving with a buffer of the resource content.
	 */
	async getBuffer() {
		if (this._contentDrained) {
			throw new Error(`Content of Resource ${this._path} has been drained. ` +
				"This might be caused by requesting resource content after a content stream has been " +
				"requested and no new content (e.g. a new stream) has been set.");
		}
		if (this._buffer) {
			return this._buffer;
		} else if (this._createStream || this._stream) {
			return this._getBufferFromStream();
		} else {
			throw new Error(`Resource ${this._path} has no content`);
		}
	}

	/**
	 * Sets a Buffer as content.
	 *
	 * @public
	 * @param {Buffer} buffer Buffer instance
	 */
	setBuffer(buffer) {
		if (this._source && !this._source.modified) {
			this._source.modified = true;
		}
		this._createStream = null;
		// if (this._stream) { // TODO this may cause strange issues
		// 	this._stream.destroy();
		// }
		this._stream = null;
		this._buffer = buffer;
		this._contentDrained = false;
		this._streamDrained = false;
	}

	/**
	 * Gets a string with the resource content.
	 *
	 * @public
	 * @returns {Promise<string>} Promise resolving with the resource content.
	 */
	getString() {
		if (this._contentDrained) {
			return Promise.reject(new Error(`Content of Resource ${this._path} has been drained. ` +
				"This might be caused by requesting resource content after a content stream has been " +
				"requested and no new content (e.g. a new stream) has been set."));
		}
		return this.getBuffer().then((buffer) => buffer.toString());
	}

	/**
	 * Sets a String as content
	 *
	 * @public
	 * @param {string} string Resource content
	 */
	setString(string) {
		this.setBuffer(Buffer.from(string, "utf8"));
	}

	/**
	 * Gets a readable stream for the resource content.
	 *
	 * Repetitive calls of this function are only possible if new content has been set in the meantime (through
	 * [setStream]{@link @ui5/fs/Resource#setStream}, [setBuffer]{@link @ui5/fs/Resource#setBuffer}
	 * or [setString]{@link @ui5/fs/Resource#setString}). This
	 * is to prevent consumers from accessing drained streams.
	 *
	 * @public
	 * @returns {stream.Readable} Readable stream for the resource content.
	 */
	getStream() {
		if (this._contentDrained) {
			throw new Error(`Content of Resource ${this._path} has been drained. ` +
				"This might be caused by requesting resource content after a content stream has been " +
				"requested and no new content (e.g. a new stream) has been set.");
		}
		let contentStream;
		if (this._buffer) {
			const bufferStream = new stream.PassThrough();
			bufferStream.end(this._buffer);
			contentStream = bufferStream;
		} else if (this._createStream || this._stream) {
			contentStream = this._getStream();
		}
		if (!contentStream) {
			throw new Error(`Resource ${this._path} has no content`);
		}
		// If a stream instance is being returned, it will typically get drained be the consumer.
		// In that case, further content access will result in a "Content stream has been drained" error.
		// However, depending on the execution environment, a resources content stream might have been
		//	transformed into a buffer. In that case further content access is possible as a buffer can't be
		//	drained.
		// To prevent unexpected "Content stream has been drained" errors caused by changing environments, we flag
		//	the resource content as "drained" every time a stream is requested. Even if actually a buffer or
		//	createStream callback is being used.
		this._contentDrained = true;
		return contentStream;
	}

	/**
	 * Sets a readable stream as content.
	 *
	 * @public
	 * @param {stream.Readable|@ui5/fs/Resource~createStream} stream Readable stream of the resource content or
	 														callback for dynamic creation of a readable stream
	 */
	setStream(stream) {
		if (this._source && !this._source.modified) {
			this._source.modified = true;
		}
		this._buffer = null;
		// if (this._stream) { // TODO this may cause strange issues
		// 	this._stream.destroy();
		// }
		if (typeof stream === "function") {
			this._createStream = stream;
			this._stream = null;
		} else {
			this._stream = stream;
			this._createStream = null;
		}
		this._contentDrained = false;
		this._streamDrained = false;
	}

	/**
	 * Gets the resources path
	 *
	 * @public
	 * @returns {string} (Virtual) path of the resource
	 */
	getPath() {
		return this._path;
	}

	/**
	 * Sets the resources path
	 *
	 * @public
	 * @param {string} path (Virtual) path of the resource
	 */
	setPath(path) {
		this._path = path;
		this._name = Resource._getNameFromPath(path);
	}

	/**
	 * Gets the resource name
	 *
	 * @public
	 * @returns {string} Name of the resource
	 */
	getName() {
		return this._name;
	}

	/**
	 * Gets the resources stat info.
	 * Note that a resources stat information is not updated when the resource is being modified.
	 * Also, depending on the used adapter, some fields might be missing which would be present for a
	 * [fs.Stats]{@link https://nodejs.org/api/fs.html#fs_class_fs_stats} instance.
	 *
	 * @public
	 * @returns {fs.Stats|object} Instance of [fs.Stats]{@link https://nodejs.org/api/fs.html#fs_class_fs_stats}
	 *								or similar object
	 */
	getStatInfo() {
		return this._statInfo;
	}

	/**
	 * Size in bytes allocated by the underlying buffer.
	 *
	 * @see {TypedArray#byteLength}
	 * @returns {Promise<number>} size in bytes, <code>0</code> if there is no content yet
	 */
	async getSize() {
		// if resource does not have any content it should have 0 bytes
		if (!this._buffer && !this._createStream && !this._stream) {
			return 0;
		}
		const buffer = await this.getBuffer();
		return buffer.byteLength;
	}

	/**
	 * Adds a resource collection name that was involved in locating this resource.
	 *
	 * @param {string} name Resource collection name
	 */
	pushCollection(name) {
		this._collections.push(name);
	}

	/**
	 * Returns a clone of the resource. The clones content is independent from that of the original resource
	 *
	 * @public
	 * @returns {Promise<@ui5/fs/Resource>} Promise resolving with the clone
	 */
	async clone() {
		const options = await this._getCloneOptions();
		return new Resource(options);
	}

	async _getCloneOptions() {
		const options = {
			path: this._path,
			statInfo: clone(this._statInfo),
			source: this._source
		};

		if (this._stream) {
			options.buffer = await this._getBufferFromStream();
		} else if (this._createStream) {
			options.createStream = this._createStream;
		} else if (this._buffer) {
			options.buffer = this._buffer;
		}

		return options;
	}

	/**
	 * Retrieve the project assigned to the resource
	 *
	 * @public
	 * @returns {@ui5/project/specifications/Project} Project this resource is associated with
	 */
	getProject() {
		return this.__project;
	}

	/**
	 * Assign a project to the resource
	 *
	 * @public
	 * @param {@ui5/project/specifications/Project} project Project this resource is associated with
	 */
	setProject(project) {
		if (this.__project) {
			throw new Error(`Unable to assign project ${project.getName()} to resource ${this._path}: ` +
				`Resource is already associated to project ${this.__project}`);
		}
		this.__project = project;
	}

	/**
	 * Check whether a project has been assigned to the resource
	 *
	 * @public
	 * @returns {boolean} True if the resource is associated with a project
	 */
	hasProject() {
		return !!this.__project;
	}

	/**
	 * Tracing: Get tree for printing out trace
	 *
	 * @returns {object} Trace tree
	 */
	getPathTree() {
		const tree = Object.create(null);

		let pointer = tree[this._path] = Object.create(null);

		for (let i = this._collections.length - 1; i >= 0; i--) {
			pointer = pointer[this._collections[i]] = Object.create(null);
		}

		return tree;
	}

	getSource() {
		return this._source || {};
	}

	/**
	 * Returns the content as stream.
	 *
	 * @private
	 * @returns {stream.Readable} Readable stream
	 */
	_getStream() {
		if (this._streamDrained) {
			throw new Error(`Content stream of Resource ${this._path} is flagged as drained.`);
		}
		if (this._createStream) {
			return this._createStream();
		}
		this._streamDrained = true;
		return this._stream;
	}

	/**
	 * Converts the buffer into a stream.
	 *
	 * @private
	 * @returns {Promise<Buffer>} Promise resolving with buffer.
	 */
	_getBufferFromStream() {
		if (this._buffering) { // Prevent simultaneous buffering, causing unexpected access to drained stream
			return this._buffering;
		}
		return this._buffering = new Promise((resolve, reject) => {
			const contentStream = this._getStream();
			const buffers = [];
			contentStream.on("data", (data) => {
				buffers.push(data);
			});
			contentStream.on("error", (err) => {
				reject(err);
			});
			contentStream.on("end", () => {
				const buffer = Buffer.concat(buffers);
				let modified;
				if (this._source) {
					modified = this._source.modified;
				}
				this.setBuffer(buffer);
				// Modified flag should be reset as the resource hasn't been modified from the outside
				if (this._source) {
					this._source.modified = modified;
				}
				this._buffering = null;
				resolve(buffer);
			});
		});
	}
}

export default Resource;
