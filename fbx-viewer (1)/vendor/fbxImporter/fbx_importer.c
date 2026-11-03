// The FBX and OBJ importer's native half, compiled to WebAssembly (see build.mjs). It reads a file
// with ufbx and writes what a glTF document needs: a hierarchy, indexed meshes with tangents, skins,
// and baked animation, as JSON and one binary buffer. Materials and textures go out as the file
// describes them, for utils/fbxImport to turn into glTF materials, since images need a canvas.

#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../mikktspace/mikktspace.h"
#include "../ufbx/ufbx.h"

#define EXPORT(name) __attribute__((export_name(name)))

enum {
	FLAG_INSPECT = 1,            // Only describe the file: no geometry or animation is built.
	FLAG_NO_ANIMATION = 2,       // Leave out animation clips.
	FLAG_NO_MORPHS = 4,          // Leave out blend shapes.
	FLAG_NO_TANGENTS = 8,        // Do not generate tangents; the shader derives them.
	FLAG_OBJ = 16,               // The file is a Wavefront OBJ.
	FLAG_RECOMPUTE_NORMALS = 32, // Ignore the file's normals and work them out from smoothing_angle.
	FLAG_NO_SKIN = 64,           // Leave out skin weights and skeleton binding.
	FLAG_NO_MESHES = 128,        // Leave out every mesh (an animation-only import).
	FLAG_NO_LOOSE_MESHES = 512,  // Leave out meshes outside the skeleton of a rigged file.
};

// Glossy curved surfaces: past this many triangles in one mesh part, tangents would take longer and
// more memory than they are worth, and the shader's derived tangents are used for that part.
#define MAX_TANGENT_TRIANGLES 2000000
#define MAX_UV_SETS 4
#define MAX_INFLUENCES 4

// glTF component types, buffer targets
#define GL_UNSIGNED_BYTE 5121
#define GL_UNSIGNED_SHORT 5123
#define GL_UNSIGNED_INT 5125
#define GL_FLOAT 5126
#define GL_ARRAY_BUFFER 34962
#define GL_ELEMENT_ARRAY_BUFFER 34963

// --- Growing buffers ---

typedef struct {
	char *data;
	size_t length;
	size_t capacity;
} Buffer;

static void *checked_malloc(size_t size) {
	void *block = malloc(size ? size : 1);
	// Out of memory: the trap surfaces in the worker, which reports the model as too large.
	if (!block) __builtin_trap();
	return block;
}

static void buffer_reserve(Buffer *buffer, size_t extra) {
	size_t needed = buffer->length + extra;
	if (needed <= buffer->capacity) return;
	size_t capacity = buffer->capacity ? buffer->capacity : 4096;
	while (capacity < needed) capacity += capacity / 2 + 4096;
	char *grown = realloc(buffer->data, capacity);
	if (!grown) __builtin_trap();
	buffer->data = grown;
	buffer->capacity = capacity;
}

static void buffer_write(Buffer *buffer, const void *data, size_t size) {
	buffer_reserve(buffer, size);
	memcpy(buffer->data + buffer->length, data, size);
	buffer->length += size;
}

static void buffer_free(Buffer *buffer) {
	free(buffer->data);
	memset(buffer, 0, sizeof(*buffer));
}

// --- JSON ---

static void json_raw(Buffer *out, const char *text) { buffer_write(out, text, strlen(text)); }

static void json_string_len(Buffer *out, const char *text, size_t length) {
	buffer_reserve(out, length + 2);
	buffer_write(out, "\"", 1);
	for (size_t i = 0; i < length; i++) {
		unsigned char c = (unsigned char)text[i];
		if (c == '"' || c == '\\') {
			char escaped[2] = { '\\', (char)c };
			buffer_write(out, escaped, 2);
		} else if (c < 0x20) {
			char escaped[8];
			int n = snprintf(escaped, sizeof(escaped), "\\u%04x", c);
			buffer_write(out, escaped, (size_t)n);
		} else {
			buffer_write(out, &c, 1);
		}
	}
	buffer_write(out, "\"", 1);
}

static void json_string(Buffer *out, ufbx_string text) { json_string_len(out, text.data, text.length); }

static void json_number(Buffer *out, double value) {
	if (!isfinite(value)) value = 0.0;
	char text[40];
	int n = snprintf(text, sizeof(text), "%.9g", value);
	buffer_write(out, text, (size_t)n);
}

static void json_integer(Buffer *out, long long value) {
	char text[32];
	int n = snprintf(text, sizeof(text), "%lld", value);
	buffer_write(out, text, (size_t)n);
}

static void json_key(Buffer *out, const char *key) {
	if (out->length && out->data[out->length - 1] != '{' && out->data[out->length - 1] != '[') json_raw(out, ",");
	json_raw(out, "\"");
	json_raw(out, key);
	json_raw(out, "\":");
}

static void json_key_number(Buffer *out, const char *key, double value) { json_key(out, key); json_number(out, value); }
static void json_key_integer(Buffer *out, const char *key, long long value) { json_key(out, key); json_integer(out, value); }
static void json_key_bool(Buffer *out, const char *key, bool value) { json_key(out, key); json_raw(out, value ? "true" : "false"); }
static void json_key_string(Buffer *out, const char *key, ufbx_string value) { json_key(out, key); json_string(out, value); }

static void json_item(Buffer *out) {
	if (out->length && out->data[out->length - 1] != '[' && out->data[out->length - 1] != '{') json_raw(out, ",");
}

static void json_key_floats(Buffer *out, const char *key, const double *values, int count) {
	json_key(out, key);
	json_raw(out, "[");
	for (int i = 0; i < count; i++) {
		if (i) json_raw(out, ",");
		json_number(out, values[i]);
	}
	json_raw(out, "]");
}

// --- Everything one import builds ---

typedef struct {
	ufbx_scene *scene;
	Buffer binary;
	Buffer json;
	// Arrays of the glTF document, each without its brackets.
	Buffer views;
	Buffer accessors;
	Buffer nodes;
	Buffer meshes;
	Buffer skins;
	Buffer animations;
	int view_count;
	int accessor_count;
	int skin_count;
	int flags;
	double smoothing_angle;
	char error[1024];
	size_t error_length;
	// Per ufbx node: its glTF node, or -1 for a root with nothing to say.
	int *node_index;
	// Per ufbx mesh: its glTF mesh, or -1 for one with no triangles.
	int *mesh_index;
	// A node's glTF mesh, when its materials differ from the first of the mesh's other nodes.
	int *node_mesh;
	// The ufbx mesh each glTF mesh came from.
	int *mesh_source;
	int mesh_source_count;
	// Per ufbx skin deformer: its glTF skin, or -1.
	int *skin_index;
	// Counts for the report.
	size_t tangents_generated;
	size_t tangents_from_file;
	size_t parts_without_tangents;
	size_t vertices_over_influence_limit;
	size_t vertices_without_weights;
	size_t output_vertices;
	size_t output_triangles;
	size_t degenerate_triangles;
	int max_influences_in_file;
	Buffer clip_report;
	size_t clip_count;
	bool has_skin;
} Import;

static Import g;

static void import_free(void) {
	if (g.scene) ufbx_free_scene(g.scene);
	buffer_free(&g.binary);
	buffer_free(&g.json);
	buffer_free(&g.views);
	buffer_free(&g.accessors);
	buffer_free(&g.nodes);
	buffer_free(&g.meshes);
	buffer_free(&g.skins);
	buffer_free(&g.animations);
	buffer_free(&g.clip_report);
	free(g.node_index);
	free(g.mesh_index);
	free(g.node_mesh);
	free(g.mesh_source);
	free(g.skin_index);
	memset(&g, 0, sizeof(g));
}

// --- Buffer views and accessors ---

/** Appends `size` bytes to the binary buffer, aligned for any component type, as a new buffer view. */
static int write_view(const void *data, size_t size, int target) {
	size_t padding = (4 - (g.binary.length & 3)) & 3;
	static const char zeros[4] = { 0, 0, 0, 0 };
	buffer_write(&g.binary, zeros, padding);
	size_t offset = g.binary.length;
	if (size) buffer_write(&g.binary, data, size);
	json_item(&g.views);
	json_raw(&g.views, "{\"buffer\":0,\"byteOffset\":");
	json_integer(&g.views, (long long)offset);
	json_raw(&g.views, ",\"byteLength\":");
	json_integer(&g.views, (long long)size);
	if (target) {
		json_raw(&g.views, ",\"target\":");
		json_integer(&g.views, target);
	}
	json_raw(&g.views, "}");
	return g.view_count++;
}

static int write_accessor(int view, int component, size_t count, const char *type, const float *min, const float *max, int bound_count) {
	json_item(&g.accessors);
	json_raw(&g.accessors, "{\"bufferView\":");
	json_integer(&g.accessors, view);
	json_raw(&g.accessors, ",\"componentType\":");
	json_integer(&g.accessors, component);
	json_raw(&g.accessors, ",\"count\":");
	json_integer(&g.accessors, (long long)count);
	json_raw(&g.accessors, ",\"type\":\"");
	json_raw(&g.accessors, type);
	json_raw(&g.accessors, "\"");
	if (bound_count) {
		json_raw(&g.accessors, ",\"min\":[");
		for (int i = 0; i < bound_count; i++) {
			if (i) json_raw(&g.accessors, ",");
			json_number(&g.accessors, min[i]);
		}
		json_raw(&g.accessors, "],\"max\":[");
		for (int i = 0; i < bound_count; i++) {
			if (i) json_raw(&g.accessors, ",");
			json_number(&g.accessors, max[i]);
		}
		json_raw(&g.accessors, "]");
	}
	json_raw(&g.accessors, "}");
	return g.accessor_count++;
}

// --- Mesh parts ---

/**
 * One mesh part's corners (three per triangle) as interleaved records. Attributes that are absent
 * take no space. Welding compares whole records, so a corner shared by two triangles becomes one
 * vertex only when every attribute agrees.
 */
typedef struct {
	size_t stride;
	int position, normal, tangent, color, joints, weights;
	int uv[MAX_UV_SETS];
	int uv_count;
	int morph_position; // First of morph_count positions, each followed by its normal when morph_normals.
	int morph_count;
	bool morph_normals;
} Layout;

static Layout layout_for(size_t uv_count, bool tangents, bool colors, bool skinned, int morph_count, bool morph_normals) {
	Layout layout;
	memset(&layout, 0, sizeof(layout));
	size_t at = 0;
	layout.position = (int)at; at += 12;
	layout.normal = (int)at; at += 12;
	layout.tangent = -1;
	if (tangents) { layout.tangent = (int)at; at += 16; }
	layout.uv_count = (int)uv_count;
	for (size_t i = 0; i < uv_count; i++) { layout.uv[i] = (int)at; at += 8; }
	layout.color = -1;
	if (colors) { layout.color = (int)at; at += 16; }
	layout.joints = layout.weights = -1;
	if (skinned) {
		layout.joints = (int)at; at += 8;
		layout.weights = (int)at; at += 16;
	}
	layout.morph_position = (int)at;
	layout.morph_count = morph_count;
	layout.morph_normals = morph_normals;
	at += (size_t)morph_count * (morph_normals ? 24u : 12u);
	layout.stride = at;
	return layout;
}

typedef struct {
	char *records;
	const Layout *layout;
	size_t triangles;
	int uv_set; // Which UV set tangents follow.
} TangentJob;

static char *job_record(const TangentJob *job, int face, int vert) { return job->records + ((size_t)face * 3u + (size_t)vert) * job->layout->stride; }

static int mikk_faces(const SMikkTSpaceContext *context) { return (int)((const TangentJob *)context->m_pUserData)->triangles; }
static int mikk_face_vertices(const SMikkTSpaceContext *context, int face) { (void)context; (void)face; return 3; }

static void mikk_position(const SMikkTSpaceContext *context, float out[], int face, int vert) {
	const TangentJob *job = context->m_pUserData;
	memcpy(out, job_record(job, face, vert) + job->layout->position, 12);
}

static void mikk_normal(const SMikkTSpaceContext *context, float out[], int face, int vert) {
	const TangentJob *job = context->m_pUserData;
	memcpy(out, job_record(job, face, vert) + job->layout->normal, 12);
}

static void mikk_uv(const SMikkTSpaceContext *context, float out[], int face, int vert) {
	const TangentJob *job = context->m_pUserData;
	memcpy(out, job_record(job, face, vert) + job->layout->uv[job->uv_set], 8);
}

static void mikk_set(const SMikkTSpaceContext *context, const float tangent[], float sign, int face, int vert) {
	const TangentJob *job = context->m_pUserData;
	float value[4] = { tangent[0], tangent[1], tangent[2], sign };
	memcpy(job_record(job, face, vert) + job->layout->tangent, value, 16);
}

static bool generate_tangents(char *records, const Layout *layout, size_t triangles, int uv_set) {
	TangentJob job = { records, layout, triangles, uv_set };
	SMikkTSpaceInterface interface_;
	memset(&interface_, 0, sizeof(interface_));
	interface_.m_getNumFaces = mikk_faces;
	interface_.m_getNumVerticesOfFace = mikk_face_vertices;
	interface_.m_getPosition = mikk_position;
	interface_.m_getNormal = mikk_normal;
	interface_.m_getTexCoord = mikk_uv;
	interface_.m_setTSpaceBasic = mikk_set;
	SMikkTSpaceContext context;
	memset(&context, 0, sizeof(context));
	context.m_pInterface = &interface_;
	context.m_pUserData = &job;
	return genTangSpaceDefault(&context) != 0;
}

/** A material's normal map, when it has one the importer can use. */
static ufbx_texture *material_normal_map(const ufbx_material *material) {
	if (!material) return NULL;
	if (material->pbr.normal_map.texture) return material->pbr.normal_map.texture;
	return material->fbx.normal_map.texture;
}

/** The index of a UV set by name, or 0 when the name is empty or unknown. */
static int uv_set_named(const ufbx_mesh *mesh, ufbx_string name) {
	if (!name.length) return 0;
	for (size_t i = 0; i < mesh->uv_sets.count && i < MAX_UV_SETS; i++) {
		if (mesh->uv_sets.data[i].name.length == name.length && !memcmp(mesh->uv_sets.data[i].name.data, name.data, name.length)) return (int)i;
	}
	return 0;
}

static float srgb_to_linear(float value) {
	return value <= 0.04045f ? value / 12.92f : powf((value + 0.055f) / 1.055f, 2.4f);
}

/** Blend shapes spread out per file vertex, which is much quicker to read per corner than searching each shape. */
typedef struct {
	float *positions; // num_vertices * 3 per shape
	float *normals;   // num_vertices * 3 per shape, or NULL
} DenseShape;

static void normalize3f(float *n) {
	float length = sqrtf(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
	if (length > 1e-12f) {
		n[0] /= length; n[1] /= length; n[2] /= length;
	} else {
		n[0] = 0; n[1] = 1; n[2] = 0;
	}
}

/**
 * Corner normals worked out from the geometry: faces meeting at a vertex at less than the smoothing
 * angle share a smooth normal, and sharper edges stay hard. Faces are weighted by the angle at the
 * corner so a vertex's normal does not depend on how its faces were cut into triangles.
 */
static void compute_smoothed_normals(const ufbx_mesh *mesh, float *corner_normals, double smoothing_angle) {
	size_t num_vertices = mesh->num_vertices;
	size_t num_indices = mesh->num_indices;
	float *face_normals = checked_malloc(mesh->num_faces * 3 * sizeof(float));
	uint32_t *corner_face = checked_malloc(num_indices * sizeof(uint32_t));
	// Corners at each vertex, as a linked list through `next`.
	uint32_t *head = checked_malloc(num_vertices * sizeof(uint32_t));
	uint32_t *next = checked_malloc(num_indices * sizeof(uint32_t));
	memset(head, 0xff, num_vertices * sizeof(uint32_t));
	for (size_t f = 0; f < mesh->num_faces; f++) {
		ufbx_face face = mesh->faces.data[f];
		double nx = 0, ny = 0, nz = 0;
		// Newell's method, which also holds for an n-gon that is not quite flat.
		for (uint32_t i = 0; i < face.num_indices; i++) {
			ufbx_vec3 a = ufbx_get_vertex_vec3(&mesh->vertex_position, face.index_begin + i);
			ufbx_vec3 b = ufbx_get_vertex_vec3(&mesh->vertex_position, face.index_begin + (i + 1) % face.num_indices);
			nx += (a.y - b.y) * (a.z + b.z);
			ny += (a.z - b.z) * (a.x + b.x);
			nz += (a.x - b.x) * (a.y + b.y);
		}
		float normal[3] = { (float)nx, (float)ny, (float)nz };
		float length = sqrtf(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
		if (length > 1e-20f) { normal[0] /= length; normal[1] /= length; normal[2] /= length; }
		memcpy(face_normals + f * 3, normal, 12);
		for (uint32_t i = 0; i < face.num_indices; i++) {
			uint32_t index = face.index_begin + i;
			corner_face[index] = (uint32_t)f;
			uint32_t vertex = mesh->vertex_indices.data[index];
			next[index] = head[vertex];
			head[vertex] = index;
		}
	}
	float limit = cosf((float)(smoothing_angle * 3.14159265358979 / 180.0));
	for (size_t f = 0; f < mesh->num_faces; f++) {
		ufbx_face face = mesh->faces.data[f];
		const float *own = face_normals + f * 3;
		for (uint32_t i = 0; i < face.num_indices; i++) {
			uint32_t index = face.index_begin + i;
			double sum[3] = { 0, 0, 0 };
			for (uint32_t other = head[mesh->vertex_indices.data[index]]; other != UINT32_MAX; other = next[other]) {
				const float *theirs = face_normals + (size_t)corner_face[other] * 3;
				if (own[0] * theirs[0] + own[1] * theirs[1] + own[2] * theirs[2] < limit) continue;
				// Weight by the corner's angle in its own face.
				ufbx_face their_face = mesh->faces.data[corner_face[other]];
				uint32_t local = other - their_face.index_begin;
				ufbx_vec3 p = ufbx_get_vertex_vec3(&mesh->vertex_position, other);
				ufbx_vec3 a = ufbx_get_vertex_vec3(&mesh->vertex_position, their_face.index_begin + (local + their_face.num_indices - 1) % their_face.num_indices);
				ufbx_vec3 b = ufbx_get_vertex_vec3(&mesh->vertex_position, their_face.index_begin + (local + 1) % their_face.num_indices);
				double ax = a.x - p.x, ay = a.y - p.y, az = a.z - p.z, bx = b.x - p.x, by = b.y - p.y, bz = b.z - p.z;
				double la = sqrt(ax * ax + ay * ay + az * az), lb = sqrt(bx * bx + by * by + bz * bz);
				double angle = 0.0;
				if (la > 1e-20 && lb > 1e-20) {
					double c = (ax * bx + ay * by + az * bz) / (la * lb);
					angle = acos(c < -1.0 ? -1.0 : c > 1.0 ? 1.0 : c);
				}
				sum[0] += theirs[0] * angle; sum[1] += theirs[1] * angle; sum[2] += theirs[2] * angle;
			}
			float normal[3] = { (float)sum[0], (float)sum[1], (float)sum[2] };
			normalize3f(normal);
			memcpy(corner_normals + (size_t)index * 3, normal, 12);
		}
	}
	free(face_normals);
	free(corner_face);
	free(head);
	free(next);
}

/** Writes one part of a mesh as a glTF primitive; returns false when it has no triangles. */
static bool write_primitive(const ufbx_mesh *mesh, const ufbx_mesh_part *part, const ufbx_material *material, int material_index,
	const ufbx_skin_deformer *skin, const DenseShape *shapes, int shape_count, const float *corner_normals, bool *wrote_any) {
	size_t triangle_budget = part->num_triangles;
	if (!triangle_budget) return false;

	bool has_file_normals = mesh->vertex_normal.exists;
	bool has_file_tangents = mesh->vertex_tangent.exists && mesh->vertex_bitangent.exists;
	size_t uv_count = mesh->uv_sets.count < MAX_UV_SETS ? mesh->uv_sets.count : MAX_UV_SETS;
	ufbx_texture *normal_map = material_normal_map(material);
	bool wants_tangents = normal_map && uv_count > 0 && !(g.flags & FLAG_NO_TANGENTS);
	bool too_large = triangle_budget > MAX_TANGENT_TRIANGLES;
	if (wants_tangents && too_large) g.parts_without_tangents++;
	bool tangents = wants_tangents && !too_large;
	bool colors = mesh->vertex_color.exists;
	bool skinned = skin != NULL;
	bool morph_normals = false;
	for (int s = 0; s < shape_count; s++) if (shapes[s].normals) morph_normals = true;
	Layout layout = layout_for(uv_count, tangents, colors, skinned, shape_count, morph_normals);

	size_t corner_capacity = triangle_budget * 3;
	char *records = checked_malloc(corner_capacity * layout.stride);
	memset(records, 0, corner_capacity * layout.stride);
	size_t triangulation_capacity = mesh->max_face_triangles * 3;
	uint32_t *triangulated = checked_malloc((triangulation_capacity ? triangulation_capacity : 3) * sizeof(uint32_t));

	size_t corners = 0;
	for (size_t i = 0; i < part->face_indices.count; i++) {
		ufbx_face face = mesh->faces.data[part->face_indices.data[i]];
		if (face.num_indices < 3) continue;
		uint32_t count = ufbx_triangulate_face(triangulated, triangulation_capacity, mesh, face);
		for (uint32_t c = 0; c < count * 3; c++) {
			uint32_t index = triangulated[c];
			char *record = records + corners * layout.stride;
			ufbx_vec3 position = ufbx_get_vertex_vec3(&mesh->vertex_position, index);
			float p[3] = { (float)position.x, (float)position.y, (float)position.z };
			memcpy(record + layout.position, p, 12);
			if (corner_normals) {
				memcpy(record + layout.normal, corner_normals + (size_t)index * 3, 12);
			} else if (has_file_normals) {
				ufbx_vec3 normal = ufbx_get_vertex_vec3(&mesh->vertex_normal, index);
				float n[3] = { (float)normal.x, (float)normal.y, (float)normal.z };
				normalize3f(n);
				memcpy(record + layout.normal, n, 12);
			}
			for (size_t u = 0; u < uv_count; u++) {
				const ufbx_uv_set *set = &mesh->uv_sets.data[u];
				ufbx_vec2 uv = set->vertex_uv.exists ? ufbx_get_vertex_vec2(&set->vertex_uv, index) : (ufbx_vec2){ 0, 0 };
				float value[2] = { (float)uv.x, (float)uv.y };
				memcpy(record + layout.uv[u], value, 8);
			}
			if (tangents && has_file_tangents && !corner_normals) {
				ufbx_vec3 tangent = ufbx_get_vertex_vec3(&mesh->vertex_tangent, index);
				ufbx_vec3 bitangent = ufbx_get_vertex_vec3(&mesh->vertex_bitangent, index);
				float n[3];
				memcpy(n, record + layout.normal, 12);
				double cx = n[1] * tangent.z - n[2] * tangent.y;
				double cy = n[2] * tangent.x - n[0] * tangent.z;
				double cz = n[0] * tangent.y - n[1] * tangent.x;
				float value[4] = { (float)tangent.x, (float)tangent.y, (float)tangent.z, cx * bitangent.x + cy * bitangent.y + cz * bitangent.z < 0 ? -1.0f : 1.0f };
				normalize3f(value);
				memcpy(record + layout.tangent, value, 16);
			}
			if (colors) {
				ufbx_vec4 color = ufbx_get_vertex_vec4(&mesh->vertex_color, index);
				float value[4] = { srgb_to_linear((float)color.x), srgb_to_linear((float)color.y), srgb_to_linear((float)color.z), (float)color.w };
				memcpy(record + layout.color, value, 16);
			}
			uint32_t vertex = mesh->vertex_indices.data[index];
			if (skinned && vertex < skin->vertices.count) {
				ufbx_skin_vertex influence = skin->vertices.data[vertex];
				uint16_t joints[MAX_INFLUENCES] = { 0, 0, 0, 0 };
				float weights[MAX_INFLUENCES] = { 0, 0, 0, 0 };
				uint32_t kept = influence.num_weights < MAX_INFLUENCES ? influence.num_weights : MAX_INFLUENCES;
				float total = 0;
				// Weights are sorted strongest first: the strongest are kept and made to sum to one.
				for (uint32_t w = 0; w < kept; w++) {
					ufbx_skin_weight weight = skin->weights.data[influence.weight_begin + w];
					joints[w] = (uint16_t)weight.cluster_index;
					weights[w] = (float)weight.weight;
					total += weights[w];
				}
				if (total > 1e-8f) {
					for (uint32_t w = 0; w < kept; w++) weights[w] /= total;
				} else {
					weights[0] = 1.0f;
				}
				memcpy(record + layout.joints, joints, 8);
				memcpy(record + layout.weights, weights, 16);
			}
			for (int s = 0; s < shape_count; s++) {
				char *slot = record + layout.morph_position + (size_t)s * (morph_normals ? 24u : 12u);
				memcpy(slot, shapes[s].positions + (size_t)vertex * 3, 12);
				if (morph_normals && shapes[s].normals) memcpy(slot + 12, shapes[s].normals + (size_t)vertex * 3, 12);
			}
			corners++;
		}
	}
	free(triangulated);
	if (!corners) {
		free(records);
		return false;
	}

	if (tangents && (!has_file_tangents || corner_normals)) {
		int uv_set = uv_set_named(mesh, normal_map->uv_set);
		if (generate_tangents(records, &layout, corners / 3, uv_set)) {
			g.tangents_generated++;
		}
	} else if (tangents) {
		g.tangents_from_file++;
	}

	// One stream of whole records, so welding keeps a single allocation.
	uint32_t *indices = checked_malloc(corners * sizeof(uint32_t));
	ufbx_vertex_stream stream = { records, corners, layout.stride };
	ufbx_error error;
	size_t vertex_count = ufbx_generate_indices(&stream, 1, indices, corners, NULL, &error);
	if (error.type != UFBX_ERROR_NONE) {
		// Welding could not run: every corner stays its own vertex.
		for (size_t i = 0; i < corners; i++) indices[i] = (uint32_t)i;
		vertex_count = corners;
	}

	g.output_vertices += vertex_count;
	g.output_triangles += corners / 3;

	// Out of the records into one array per attribute, flipping V to glTF's top-left origin.
	void *column = checked_malloc(vertex_count * 16 + 16);
	float min[3] = { INFINITY, INFINITY, INFINITY };
	float max[3] = { -INFINITY, -INFINITY, -INFINITY };
	#define COPY_COLUMN(offset, size) do { \
		for (size_t v = 0; v < vertex_count; v++) memcpy((char *)column + v * (size), records + v * layout.stride + (offset), (size)); \
	} while (0)

	COPY_COLUMN(layout.position, 12);
	for (size_t v = 0; v < vertex_count; v++) {
		const float *p = (const float *)column + v * 3;
		for (int axis = 0; axis < 3; axis++) {
			if (p[axis] < min[axis]) min[axis] = p[axis];
			if (p[axis] > max[axis]) max[axis] = p[axis];
		}
	}
	int position_accessor = write_accessor(write_view(column, vertex_count * 12, GL_ARRAY_BUFFER), GL_FLOAT, vertex_count, "VEC3", min, max, 3);

	COPY_COLUMN(layout.normal, 12);
	int normal_accessor = write_accessor(write_view(column, vertex_count * 12, GL_ARRAY_BUFFER), GL_FLOAT, vertex_count, "VEC3", NULL, NULL, 0);

	int tangent_accessor = -1;
	if (tangents) {
		COPY_COLUMN(layout.tangent, 16);
		tangent_accessor = write_accessor(write_view(column, vertex_count * 16, GL_ARRAY_BUFFER), GL_FLOAT, vertex_count, "VEC4", NULL, NULL, 0);
	}

	int uv_accessor[MAX_UV_SETS];
	for (size_t u = 0; u < uv_count; u++) {
		COPY_COLUMN(layout.uv[u], 8);
		float *values = column;
		for (size_t v = 0; v < vertex_count; v++) values[v * 2 + 1] = 1.0f - values[v * 2 + 1];
		uv_accessor[u] = write_accessor(write_view(column, vertex_count * 8, GL_ARRAY_BUFFER), GL_FLOAT, vertex_count, "VEC2", NULL, NULL, 0);
	}

	int color_accessor = -1;
	if (colors) {
		COPY_COLUMN(layout.color, 16);
		color_accessor = write_accessor(write_view(column, vertex_count * 16, GL_ARRAY_BUFFER), GL_FLOAT, vertex_count, "VEC4", NULL, NULL, 0);
	}

	int joints_accessor = -1, weights_accessor = -1;
	if (skinned) {
		COPY_COLUMN(layout.joints, 8);
		joints_accessor = write_accessor(write_view(column, vertex_count * 8, GL_ARRAY_BUFFER), GL_UNSIGNED_SHORT, vertex_count, "VEC4", NULL, NULL, 0);
		COPY_COLUMN(layout.weights, 16);
		weights_accessor = write_accessor(write_view(column, vertex_count * 16, GL_ARRAY_BUFFER), GL_FLOAT, vertex_count, "VEC4", NULL, NULL, 0);
	}

	// A primitive's morph targets.
	int *morph_accessors = NULL;
	if (shape_count) {
		morph_accessors = checked_malloc((size_t)shape_count * 2 * sizeof(int));
		for (int s = 0; s < shape_count; s++) {
			size_t slot = (size_t)layout.morph_position + (size_t)s * (morph_normals ? 24u : 12u);
			COPY_COLUMN(slot, 12);
			float shape_min[3] = { INFINITY, INFINITY, INFINITY };
			float shape_max[3] = { -INFINITY, -INFINITY, -INFINITY };
			for (size_t v = 0; v < vertex_count; v++) {
				const float *p = (const float *)column + v * 3;
				for (int axis = 0; axis < 3; axis++) {
					if (p[axis] < shape_min[axis]) shape_min[axis] = p[axis];
					if (p[axis] > shape_max[axis]) shape_max[axis] = p[axis];
				}
			}
			morph_accessors[s * 2] = write_accessor(write_view(column, vertex_count * 12, GL_ARRAY_BUFFER), GL_FLOAT, vertex_count, "VEC3", shape_min, shape_max, 3);
			if (morph_normals) {
				COPY_COLUMN(slot + 12, 12);
				morph_accessors[s * 2 + 1] = write_accessor(write_view(column, vertex_count * 12, GL_ARRAY_BUFFER), GL_FLOAT, vertex_count, "VEC3", NULL, NULL, 0);
			}
		}
	}
	#undef COPY_COLUMN
	free(column);
	free(records);

	// Indices, as small as they fit.
	int index_accessor;
	if (vertex_count <= 0xffff) {
		uint16_t *small = checked_malloc(corners * sizeof(uint16_t));
		for (size_t i = 0; i < corners; i++) small[i] = (uint16_t)indices[i];
		index_accessor = write_accessor(write_view(small, corners * 2, GL_ELEMENT_ARRAY_BUFFER), GL_UNSIGNED_SHORT, corners, "SCALAR", NULL, NULL, 0);
		free(small);
	} else {
		index_accessor = write_accessor(write_view(indices, corners * 4, GL_ELEMENT_ARRAY_BUFFER), GL_UNSIGNED_INT, corners, "SCALAR", NULL, NULL, 0);
	}
	free(indices);

	Buffer *out = &g.meshes;
	if (*wrote_any) json_raw(out, ",");
	*wrote_any = true;
	json_raw(out, "{\"attributes\":{\"POSITION\":");
	json_integer(out, position_accessor);
	json_raw(out, ",\"NORMAL\":");
	json_integer(out, normal_accessor);
	if (tangent_accessor >= 0) { json_raw(out, ",\"TANGENT\":"); json_integer(out, tangent_accessor); }
	for (size_t u = 0; u < uv_count; u++) {
		char name[32];
		snprintf(name, sizeof(name), ",\"TEXCOORD_%d\":", (int)u);
		json_raw(out, name);
		json_integer(out, uv_accessor[u]);
	}
	if (color_accessor >= 0) { json_raw(out, ",\"COLOR_0\":"); json_integer(out, color_accessor); }
	if (joints_accessor >= 0) {
		json_raw(out, ",\"JOINTS_0\":");
		json_integer(out, joints_accessor);
		json_raw(out, ",\"WEIGHTS_0\":");
		json_integer(out, weights_accessor);
	}
	json_raw(out, "},\"indices\":");
	json_integer(out, index_accessor);
	json_raw(out, ",\"mode\":4");
	if (material_index >= 0) { json_raw(out, ",\"material\":"); json_integer(out, material_index); }
	if (shape_count) {
		json_raw(out, ",\"targets\":[");
		for (int s = 0; s < shape_count; s++) {
			if (s) json_raw(out, ",");
			json_raw(out, "{\"POSITION\":");
			json_integer(out, morph_accessors[s * 2]);
			if (morph_normals) {
				json_raw(out, ",\"NORMAL\":");
				json_integer(out, morph_accessors[s * 2 + 1]);
			}
			json_raw(out, "}");
		}
		json_raw(out, "]");
		free(morph_accessors);
	}
	json_raw(out, "}");
	return true;
}

/** The shape a blend channel reaches at full weight. */
static ufbx_blend_shape *channel_shape(const ufbx_blend_channel *channel) {
	if (channel->target_shape) return channel->target_shape;
	if (channel->keyframes.count) return channel->keyframes.data[channel->keyframes.count - 1].shape;
	return NULL;
}

// --- What names say. utils/modelConventions.ts takes these out of the model; here they are only counted and measured. ---

static bool name_has_prefix(ufbx_string name, const char *prefix) {
	size_t length = strlen(prefix);
	return name.length >= length && !memcmp(name.data, prefix, length);
}

static bool name_is_shape(ufbx_string name) {
	return name_has_prefix(name, "UCX_") || name_has_prefix(name, "UBX_") || name_has_prefix(name, "USP_") || name_has_prefix(name, "UCP_");
}

/** Whether a node is a collision shape or part of one. */
static bool node_is_shape(const ufbx_node *node) {
	for (const ufbx_node *at = node; at; at = at->parent) if (name_is_shape(at->name)) return true;
	return false;
}

typedef struct {
	bool found;
	size_t stem;       // Length of what comes before _LOD.
	unsigned level;
	const char *copy;  // A ".001" after it, as Blender numbers copies.
	size_t copy_length;
} LevelName;

/** Reads a name of the form Name_LOD1 or Name_LOD1.001, in either case. */
static LevelName level_name(ufbx_string name) {
	LevelName out;
	memset(&out, 0, sizeof(out));
	size_t end = name.length;
	size_t dot = end;
	while (dot > 0 && name.data[dot - 1] >= '0' && name.data[dot - 1] <= '9') dot--;
	if (dot > 0 && dot < end && name.data[dot - 1] == '.') {
		out.copy = name.data + dot - 1;
		out.copy_length = end - dot + 1;
		end = dot - 1;
	}
	size_t digits = end;
	while (digits > 0 && name.data[digits - 1] >= '0' && name.data[digits - 1] <= '9') digits--;
	if (digits == end || digits < 5) return out;
	const char *mark = name.data + digits - 4;
	if (mark[0] != '_' || (mark[1] | 32) != 'l' || (mark[2] | 32) != 'o' || (mark[3] | 32) != 'd') return out;
	for (size_t i = digits; i < end; i++) out.level = out.level * 10 + (unsigned)(name.data[i] - '0');
	out.stem = digits - 4;
	out.found = true;
	return out;
}

static bool same_text(const char *a, const char *b, size_t length) {
	for (size_t i = 0; i < length; i++) {
		char x = a[i], y = b[i];
		if (x >= 'A' && x <= 'Z') x += 32;
		if (y >= 'A' && y <= 'Z') y += 32;
		if (x != y) return false;
	}
	return true;
}

/** Whether a mesh is a simpler version of one beside it: of the plain name, or of a lower level. */
static bool node_is_coarser_level(const ufbx_node *node) {
	LevelName own = level_name(node->name);
	if (!own.found || !node->parent) return false;
	for (size_t i = 0; i < node->parent->children.count; i++) {
		const ufbx_node *other = node->parent->children.data[i];
		if (other == node) continue;
		if (other->mesh && other->name.length == own.stem + own.copy_length && same_text(other->name.data, node->name.data, own.stem)
			&& (!own.copy_length || same_text(other->name.data + own.stem, own.copy, own.copy_length))) return true;
		LevelName theirs = level_name(other->name);
		if (theirs.found && theirs.level < own.level && theirs.stem == own.stem && same_text(other->name.data, node->name.data, own.stem)
			&& theirs.copy_length == own.copy_length && (!own.copy_length || same_text(theirs.copy, own.copy, own.copy_length))) return true;
	}
	return false;
}

/** Whether the import leaves a node's mesh out of what is drawn, unless that would leave nothing. */
static bool node_is_left_out(const ufbx_node *node) {
	for (const ufbx_node *at = node; at; at = at->parent) {
		if (!at->visible || name_is_shape(at->name) || name_has_prefix(at->name, "SOCKET_")) return true;
		const ufbx_node *parent = at->parent;
		if (parent && parent->attrib_type == UFBX_ELEMENT_LOD_GROUP && parent->children.count > 1 && parent->children.data[0] != at) return true;
	}
	return node_is_coarser_level(node);
}

static bool node_is_loose(const ufbx_node *node);

/** Whether two nodes of a mesh give it the same materials. */
static bool same_materials(const ufbx_mesh *mesh, const ufbx_node *a, const ufbx_node *b) {
	const ufbx_material_list *first = a->materials.count ? &a->materials : &mesh->materials;
	const ufbx_material_list *second = b->materials.count ? &b->materials : &mesh->materials;
	if (first->count != second->count) return false;
	for (size_t i = 0; i < first->count; i++) if (first->data[i] != second->data[i]) return false;
	return true;
}

static void write_meshes(void) {
	ufbx_scene *scene = g.scene;
	bool first_mesh = true;
	int next_mesh = 0;
	for (size_t m = 0; m < scene->meshes.count; m++) {
		ufbx_mesh *mesh = scene->meshes.data[m];
		g.mesh_index[m] = -1;
		if (!mesh->num_triangles || !mesh->vertex_position.exists || !mesh->instances.count) continue;
		if ((g.flags & FLAG_NO_LOOSE_MESHES) && node_is_loose(mesh->instances.data[0])) continue;

		const ufbx_skin_deformer *skin = (g.flags & FLAG_NO_SKIN) || !mesh->skin_deformers.count ? NULL : mesh->skin_deformers.data[0];
		if (skin && !skin->clusters.count) skin = NULL;
		if (skin) {
			if ((int)skin->max_weights_per_vertex > g.max_influences_in_file) g.max_influences_in_file = (int)skin->max_weights_per_vertex;
			for (size_t v = 0; v < skin->vertices.count; v++) {
				if (skin->vertices.data[v].num_weights > MAX_INFLUENCES) g.vertices_over_influence_limit++;
				if (!skin->vertices.data[v].num_weights) g.vertices_without_weights++;
			}
		}

		// Blend shapes, spread out per file vertex. A mesh's own turn and scale in its node (a 3ds Max
		// object offset) are baked into its vertices by now, but not into these offsets.
		const ufbx_node *first_node = mesh->instances.data[0];
		ufbx_vec3 no_turn = { 0.0, 0.0, 0.0 };
		ufbx_vec3 no_scale = { 1.0, 1.0, 1.0 };
		ufbx_quat own_turn = ufbx_euler_to_quat(ufbx_find_vec3(&first_node->props, "GeometricRotation", no_turn), UFBX_ROTATION_ORDER_XYZ);
		ufbx_vec3 own_scale = ufbx_find_vec3(&first_node->props, "GeometricScaling", no_scale);
		int shape_count = 0;
		DenseShape *shapes = NULL;
		if (!(g.flags & FLAG_NO_MORPHS)) {
			for (size_t b = 0; b < mesh->blend_deformers.count; b++) {
				const ufbx_blend_deformer *deformer = mesh->blend_deformers.data[b];
				for (size_t c = 0; c < deformer->channels.count; c++) if (channel_shape(deformer->channels.data[c])) shape_count++;
			}
			if (shape_count) {
				shapes = checked_malloc((size_t)shape_count * sizeof(DenseShape));
				int at = 0;
				for (size_t b = 0; b < mesh->blend_deformers.count; b++) {
					const ufbx_blend_deformer *deformer = mesh->blend_deformers.data[b];
					for (size_t c = 0; c < deformer->channels.count; c++) {
						const ufbx_blend_shape *shape = channel_shape(deformer->channels.data[c]);
						if (!shape) continue;
						float *positions = checked_malloc(mesh->num_vertices * 12);
						memset(positions, 0, mesh->num_vertices * 12);
						float *normals = NULL;
						if (shape->normal_offsets.count) {
							normals = checked_malloc(mesh->num_vertices * 12);
							memset(normals, 0, mesh->num_vertices * 12);
						}
						for (size_t o = 0; o < shape->num_offsets; o++) {
							uint32_t vertex = shape->offset_vertices.data[o];
							if (vertex >= mesh->num_vertices) continue;
							ufbx_vec3 offset = shape->position_offsets.data[o];
							offset.x *= own_scale.x;
							offset.y *= own_scale.y;
							offset.z *= own_scale.z;
							offset = ufbx_quat_rotate_vec3(own_turn, offset);
							positions[(size_t)vertex * 3] = (float)offset.x;
							positions[(size_t)vertex * 3 + 1] = (float)offset.y;
							positions[(size_t)vertex * 3 + 2] = (float)offset.z;
							if (normals) {
								ufbx_vec3 normal = ufbx_quat_rotate_vec3(own_turn, shape->normal_offsets.data[o]);
								normals[(size_t)vertex * 3] = (float)normal.x;
								normals[(size_t)vertex * 3 + 1] = (float)normal.y;
								normals[(size_t)vertex * 3 + 2] = (float)normal.z;
							}
						}
						shapes[at].positions = positions;
						shapes[at].normals = normals;
						at++;
					}
				}
			}
		}

		float *corner_normals = NULL;
		if ((g.flags & FLAG_RECOMPUTE_NORMALS) || !mesh->vertex_normal.exists) {
			corner_normals = checked_malloc(mesh->num_indices * 12);
			compute_smoothed_normals(mesh, corner_normals, g.smoothing_angle);
		}

		// A node's materials are the file's real assignment: nodes that share a mesh can differ in them,
		// and each list gets a glTF mesh of its own.
		for (size_t i = 0; i < mesh->instances.count; i++) {
			const ufbx_node *owner = mesh->instances.data[i];
			bool shared = false;
			for (size_t j = 0; j < i && !shared; j++) {
				const ufbx_node *earlier = mesh->instances.data[j];
				if (same_materials(mesh, earlier, owner)) {
					g.node_mesh[owner->typed_id] = g.node_mesh[earlier->typed_id];
					shared = true;
				}
			}
			if (shared) continue;
			const ufbx_material_list *materials = owner->materials.count ? &owner->materials : &mesh->materials;

			size_t mark = g.meshes.length;
			if (!first_mesh) json_raw(&g.meshes, ",");
			json_raw(&g.meshes, "{\"name\":");
			json_string(&g.meshes, owner->name);
			json_raw(&g.meshes, ",\"primitives\":[");
			bool wrote_any = false;
			for (size_t p = 0; p < mesh->material_parts.count; p++) {
				const ufbx_mesh_part *part = &mesh->material_parts.data[p];
				const ufbx_material *material = part->index < materials->count ? materials->data[part->index] : NULL;
				write_primitive(mesh, part, material, material ? (int)material->typed_id : -1, skin, shapes, shape_count, corner_normals, &wrote_any);
			}
			json_raw(&g.meshes, "]");
			if (shape_count) {
				json_raw(&g.meshes, ",\"extras\":{\"targetNames\":[");
				int at = 0;
				for (size_t b = 0; b < mesh->blend_deformers.count; b++) {
					const ufbx_blend_deformer *deformer = mesh->blend_deformers.data[b];
					for (size_t c = 0; c < deformer->channels.count; c++) {
						const ufbx_blend_channel *channel = deformer->channels.data[c];
						if (!channel_shape(channel)) continue;
						if (at++) json_raw(&g.meshes, ",");
						json_string(&g.meshes, channel->name);
					}
				}
				json_raw(&g.meshes, "]}");
			}
			json_raw(&g.meshes, "}");
			if (!wrote_any) {
				g.meshes.length = mark;
				continue;
			}
			first_mesh = false;
			g.node_mesh[owner->typed_id] = next_mesh;
			if (g.mesh_index[m] < 0) g.mesh_index[m] = next_mesh;
			g.mesh_source = realloc(g.mesh_source, ((size_t)next_mesh + 1) * sizeof(int));
			if (!g.mesh_source) abort();
			g.mesh_source[next_mesh] = (int)m;
			g.mesh_source_count = next_mesh + 1;
			next_mesh++;
		}
		free(corner_normals);
		if (shape_count) {
			for (int s = 0; s < shape_count; s++) {
				free(shapes[s].positions);
				free(shapes[s].normals);
			}
			free(shapes);
		}
	}
}

// --- Skins and nodes ---

/**
 * A mesh in a rigged file that the skeleton does not move: not skinned, and not under a bone. Some
 * exporters leave such things behind (Meshy's rigged characters come with a stray sphere).
 */
static bool node_is_loose(const ufbx_node *node) {
	if (!g.has_skin || !node->mesh || node->mesh->skin_deformers.count || node_is_shape(node)) return false;
	for (const ufbx_node *at = node->parent; at; at = at->parent) if (at->bone) return false;
	return true;
}

static void write_skins(void) {
	ufbx_scene *scene = g.scene;
	for (size_t s = 0; s < scene->skin_deformers.count; s++) {
		const ufbx_skin_deformer *skin = scene->skin_deformers.data[s];
		g.skin_index[s] = -1;
		if (!skin->clusters.count) continue;
		float *inverse = checked_malloc(skin->clusters.count * 16 * sizeof(float));
		for (size_t c = 0; c < skin->clusters.count; c++) {
			const ufbx_matrix *m = &skin->clusters.data[c]->geometry_to_bone;
			float *out = inverse + c * 16;
			for (int col = 0; col < 4; col++) {
				out[col * 4] = (float)m->cols[col].x;
				out[col * 4 + 1] = (float)m->cols[col].y;
				out[col * 4 + 2] = (float)m->cols[col].z;
				out[col * 4 + 3] = col == 3 ? 1.0f : 0.0f;
			}
		}
		int accessor = write_accessor(write_view(inverse, skin->clusters.count * 64, 0), GL_FLOAT, skin->clusters.count, "MAT4", NULL, NULL, 0);
		free(inverse);
		json_item(&g.skins);
		json_raw(&g.skins, "{\"inverseBindMatrices\":");
		json_integer(&g.skins, accessor);
		json_raw(&g.skins, ",\"joints\":[");
		for (size_t c = 0; c < skin->clusters.count; c++) {
			if (c) json_raw(&g.skins, ",");
			const ufbx_node *bone = skin->clusters.data[c]->bone_node;
			json_integer(&g.skins, bone ? g.node_index[bone->typed_id] : 0);
		}
		json_raw(&g.skins, "]}");
		g.skin_index[s] = g.skin_count++;
	}
}

static bool root_has_transform(const ufbx_node *root) {
	ufbx_transform t = root->local_transform;
	return t.translation.x != 0 || t.translation.y != 0 || t.translation.z != 0
		|| t.rotation.x != 0 || t.rotation.y != 0 || t.rotation.z != 0 || t.rotation.w != 1
		|| t.scale.x != 1 || t.scale.y != 1 || t.scale.z != 1;
}

/** Sets out which glTF node each file node becomes: all of them, the root only when it transforms. */
static void number_nodes(void) {
	ufbx_scene *scene = g.scene;
	int next = 0;
	bool keep_root = root_has_transform(scene->root_node);
	for (size_t i = 0; i < scene->nodes.count; i++) {
		const ufbx_node *node = scene->nodes.data[i];
		g.node_index[i] = node->is_root && !keep_root ? -1 : next++;
	}
}

/** The glTF skin of a node's mesh, or -1. */
static int node_skin(const ufbx_node *node) {
	if (!node->mesh || !node->mesh->skin_deformers.count || (g.flags & FLAG_NO_SKIN)) return -1;
	return g.skin_index[node->mesh->skin_deformers.data[0]->typed_id];
}

static void write_nodes(void) {
	ufbx_scene *scene = g.scene;
	for (size_t i = 0; i < scene->nodes.count; i++) {
		const ufbx_node *node = scene->nodes.data[i];
		if (g.node_index[i] < 0) continue;
		Buffer *out = &g.nodes;
		json_item(out);
		json_raw(out, "{");
		json_key_string(out, "name", node->name);
		ufbx_transform t = node->local_transform;
		if (t.translation.x != 0 || t.translation.y != 0 || t.translation.z != 0) {
			double value[3] = { t.translation.x, t.translation.y, t.translation.z };
			json_key_floats(out, "translation", value, 3);
		}
		if (t.rotation.x != 0 || t.rotation.y != 0 || t.rotation.z != 0 || t.rotation.w != 1) {
			double value[4] = { t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w };
			json_key_floats(out, "rotation", value, 4);
		}
		if (t.scale.x != 1 || t.scale.y != 1 || t.scale.z != 1) {
			double value[3] = { t.scale.x, t.scale.y, t.scale.z };
			json_key_floats(out, "scale", value, 3);
		}
		if (node->mesh && !(g.flags & FLAG_NO_MESHES) && g.node_mesh[node->typed_id] >= 0 && !((g.flags & FLAG_NO_LOOSE_MESHES) && node_is_loose(node))) {
			json_key_integer(out, "mesh", g.node_mesh[node->typed_id]);
			int skin = node_skin(node);
			if (skin >= 0) json_key_integer(out, "skin", skin);
		}
		if (node->children.count) {
			json_key(out, "children");
			json_raw(out, "[");
			bool first = true;
			for (size_t c = 0; c < node->children.count; c++) {
				int child = g.node_index[node->children.data[c]->typed_id];
				if (child < 0) continue;
				if (!first) json_raw(out, ",");
				first = false;
				json_integer(out, child);
			}
			json_raw(out, "]");
		}
		bool is_bone = node->bone != NULL;
		bool is_lod = node->attrib_type == UFBX_ELEMENT_LOD_GROUP;
		if (is_bone || is_lod || !node->visible) {
			json_key(out, "extras");
			json_raw(out, "{");
			if (is_bone) json_key_bool(out, "bone", true);
			if (!node->visible) json_key_bool(out, "hidden", true);
			if (is_lod) {
				const ufbx_lod_group *group = (const ufbx_lod_group *)node->attrib;
				json_key(out, "lodGroup");
				json_raw(out, "{");
				json_key_bool(out, "relative", group->relative_distances);
				json_key(out, "distances");
				json_raw(out, "[");
				for (size_t l = 0; l < group->lod_levels.count; l++) {
					if (l) json_raw(out, ",");
					json_number(out, group->lod_levels.data[l].distance);
				}
				json_raw(out, "]}");
			}
			json_raw(out, "}");
		}
		json_raw(out, "}");
	}
}

// --- Animation ---

typedef struct {
	Buffer *channels;
	Buffer *samplers;
	int sampler_count;
	// Times shared across this clip's tracks, as most tracks have the same keys.
	int *time_accessors;
	float **time_values;
	size_t *time_counts;
	size_t time_used;
	size_t time_capacity;
} ClipWriter;

/** An accessor for `count` key times, reusing one this clip already has when they are the same. */
static int clip_times(ClipWriter *clip, const float *times, size_t count) {
	for (size_t i = 0; i < clip->time_used; i++) {
		if (clip->time_counts[i] == count && !memcmp(clip->time_values[i], times, count * sizeof(float))) return clip->time_accessors[i];
	}
	float min = times[0], max = times[count - 1];
	int accessor = write_accessor(write_view(times, count * sizeof(float), 0), GL_FLOAT, count, "SCALAR", &min, &max, 1);
	if (clip->time_used == clip->time_capacity) {
		size_t capacity = clip->time_capacity ? clip->time_capacity * 2 : 16;
		clip->time_accessors = realloc(clip->time_accessors, capacity * sizeof(int));
		clip->time_values = realloc(clip->time_values, capacity * sizeof(float *));
		clip->time_counts = realloc(clip->time_counts, capacity * sizeof(size_t));
		if (!clip->time_accessors || !clip->time_values || !clip->time_counts) __builtin_trap();
		clip->time_capacity = capacity;
	}
	float *copy = checked_malloc(count * sizeof(float));
	memcpy(copy, times, count * sizeof(float));
	clip->time_accessors[clip->time_used] = accessor;
	clip->time_values[clip->time_used] = copy;
	clip->time_counts[clip->time_used] = count;
	clip->time_used++;
	return accessor;
}

/** Key times must strictly increase; two keys nearer than a float can tell apart are pushed apart. */
static void make_increasing(float *times, size_t count) {
	for (size_t i = 1; i < count; i++) {
		if (times[i] <= times[i - 1]) times[i] = nextafterf(times[i - 1], INFINITY);
	}
}

static void clip_channel(ClipWriter *clip, int node, const char *path, const float *times, size_t count, const float *values, size_t value_size, const char *type) {
	int input = clip_times(clip, times, count);
	int output = write_accessor(write_view(values, count * value_size, 0), GL_FLOAT, count, type, NULL, NULL, 0);
	json_item(clip->samplers);
	json_raw(clip->samplers, "{\"input\":");
	json_integer(clip->samplers, input);
	json_raw(clip->samplers, ",\"output\":");
	json_integer(clip->samplers, output);
	json_raw(clip->samplers, ",\"interpolation\":\"LINEAR\"}");
	json_item(clip->channels);
	json_raw(clip->channels, "{\"sampler\":");
	json_integer(clip->channels, clip->sampler_count++);
	json_raw(clip->channels, ",\"target\":{\"node\":");
	json_integer(clip->channels, node);
	json_raw(clip->channels, ",\"path\":\"");
	json_raw(clip->channels, path);
	json_raw(clip->channels, "\"}}");
}

static bool nearly(double a, double b, double epsilon) { return fabs(a - b) <= epsilon; }

/** Writes a clip's transform and blend shape tracks; returns how many keys it kept. */
static size_t write_clip_tracks(ClipWriter *clip, const ufbx_baked_anim *baked, const ufbx_anim_stack *stack, double rate, double duration, size_t *track_count) {
	ufbx_scene *scene = g.scene;
	size_t key_total = 0;
	float *times = NULL;
	float *values = NULL;
	size_t capacity = 0;
	double latest_key = 0;
	int last_node = -1;

	#define ENSURE(count, stride) do { \
		if ((count) > capacity) { \
			capacity = (count) * 2; \
			free(times); free(values); \
			times = checked_malloc(capacity * sizeof(float)); \
			values = checked_malloc(capacity * 4 * sizeof(float)); \
		} \
	} while (0)

	for (size_t n = 0; n < baked->nodes.count; n++) {
		const ufbx_baked_node *baked_node = &baked->nodes.data[n];
		const ufbx_node *node = scene->nodes.data[baked_node->typed_id];
		int index = g.node_index[node->typed_id];
		if (index < 0) continue;
		ufbx_transform rest = node->local_transform;

		// A track that holds the rest pose says nothing; a track that holds another value is kept.
		size_t count = baked_node->translation_keys.count;
		bool constant = baked_node->constant_translation && count;
		if (count && !(constant && nearly(baked_node->translation_keys.data[0].value.x, rest.translation.x, 1e-7) && nearly(baked_node->translation_keys.data[0].value.y, rest.translation.y, 1e-7) && nearly(baked_node->translation_keys.data[0].value.z, rest.translation.z, 1e-7))) {
			size_t kept = constant ? 1 : count;
			ENSURE(kept, 3);
			for (size_t k = 0; k < kept; k++) {
				ufbx_baked_vec3 key = baked_node->translation_keys.data[k];
				times[k] = (float)key.time;
				values[k * 3] = (float)key.value.x; values[k * 3 + 1] = (float)key.value.y; values[k * 3 + 2] = (float)key.value.z;
				if (key.time > latest_key) latest_key = key.time;
			}
			make_increasing(times, kept);
			clip_channel(clip, index, "translation", times, kept, values, 12, "VEC3");
			key_total += kept;
			(*track_count)++;
			last_node = index;
		}

		count = baked_node->rotation_keys.count;
		constant = baked_node->constant_rotation && count;
		if (count) {
			ufbx_quat q = count ? baked_node->rotation_keys.data[0].value : rest.rotation;
			double dot = q.x * rest.rotation.x + q.y * rest.rotation.y + q.z * rest.rotation.z + q.w * rest.rotation.w;
			if (!(constant && fabs(dot) > 1.0 - 1e-9)) {
				size_t kept = constant ? 1 : count;
				ENSURE(kept, 4);
				for (size_t k = 0; k < kept; k++) {
					ufbx_baked_quat key = baked_node->rotation_keys.data[k];
					times[k] = (float)key.time;
					values[k * 4] = (float)key.value.x; values[k * 4 + 1] = (float)key.value.y; values[k * 4 + 2] = (float)key.value.z; values[k * 4 + 3] = (float)key.value.w;
					if (key.time > latest_key) latest_key = key.time;
				}
				make_increasing(times, kept);
				clip_channel(clip, index, "rotation", times, kept, values, 16, "VEC4");
				key_total += kept;
				(*track_count)++;
				last_node = index;
			}
		}

		count = baked_node->scale_keys.count;
		constant = baked_node->constant_scale && count;
		if (count && !(constant && nearly(baked_node->scale_keys.data[0].value.x, rest.scale.x, 1e-7) && nearly(baked_node->scale_keys.data[0].value.y, rest.scale.y, 1e-7) && nearly(baked_node->scale_keys.data[0].value.z, rest.scale.z, 1e-7))) {
			size_t kept = constant ? 1 : count;
			ENSURE(kept, 3);
			for (size_t k = 0; k < kept; k++) {
				ufbx_baked_vec3 key = baked_node->scale_keys.data[k];
				times[k] = (float)key.time;
				values[k * 3] = (float)key.value.x; values[k * 3 + 1] = (float)key.value.y; values[k * 3 + 2] = (float)key.value.z;
				if (key.time > latest_key) latest_key = key.time;
			}
			make_increasing(times, kept);
			clip_channel(clip, index, "scale", times, kept, values, 12, "VEC3");
			key_total += kept;
			(*track_count)++;
			last_node = index;
		}
	}

	// Blend shape weights, sampled together per mesh as glTF keeps them.
	if (!(g.flags & FLAG_NO_MORPHS)) {
		for (size_t m = 0; m < scene->meshes.count; m++) {
			const ufbx_mesh *mesh = scene->meshes.data[m];
			if (g.mesh_index[m] < 0 || !mesh->blend_deformers.count) continue;
			int shape_count = 0;
			bool animated = false;
			for (size_t b = 0; b < mesh->blend_deformers.count; b++) {
				const ufbx_blend_deformer *deformer = mesh->blend_deformers.data[b];
				for (size_t c = 0; c < deformer->channels.count; c++) {
					const ufbx_blend_channel *channel = deformer->channels.data[c];
					if (!channel_shape(channel)) continue;
					shape_count++;
					const ufbx_baked_element *element = ufbx_find_baked_element_by_element_id((ufbx_baked_anim *)baked, channel->element_id);
					if (element && element->props.count) animated = true;
				}
			}
			if (!shape_count || !animated) continue;
			size_t samples = (size_t)ceil(duration * rate) + 1;
			if (samples < 2) samples = 2;
			float *weight_times = checked_malloc(samples * sizeof(float));
			float *weights = checked_malloc(samples * (size_t)shape_count * sizeof(float));
			for (size_t k = 0; k < samples; k++) {
				double time = duration * (double)k / (double)(samples - 1);
				weight_times[k] = (float)time;
				int at = 0;
				for (size_t b = 0; b < mesh->blend_deformers.count; b++) {
					const ufbx_blend_deformer *deformer = mesh->blend_deformers.data[b];
					for (size_t c = 0; c < deformer->channels.count; c++) {
						const ufbx_blend_channel *channel = deformer->channels.data[c];
						if (!channel_shape(channel)) continue;
						weights[k * (size_t)shape_count + (size_t)at] = (float)ufbx_evaluate_blend_weight(stack->anim, channel, time + stack->time_begin);
						at++;
					}
				}
			}
			make_increasing(weight_times, samples);
			for (size_t i = 0; i < mesh->instances.count; i++) {
				int index = g.node_index[mesh->instances.data[i]->typed_id];
				if (index < 0) continue;
				int input = clip_times(clip, weight_times, samples);
				int output = write_accessor(write_view(weights, samples * (size_t)shape_count * sizeof(float), 0), GL_FLOAT, samples * (size_t)shape_count, "SCALAR", NULL, NULL, 0);
				json_item(clip->samplers);
				json_raw(clip->samplers, "{\"input\":");
				json_integer(clip->samplers, input);
				json_raw(clip->samplers, ",\"output\":");
				json_integer(clip->samplers, output);
				json_raw(clip->samplers, ",\"interpolation\":\"LINEAR\"}");
				json_item(clip->channels);
				json_raw(clip->channels, "{\"sampler\":");
				json_integer(clip->channels, clip->sampler_count++);
				json_raw(clip->channels, ",\"target\":{\"node\":");
				json_integer(clip->channels, index);
				json_raw(clip->channels, ",\"path\":\"weights\"}}");
				key_total += samples;
				(*track_count)++;
				if (duration > latest_key) latest_key = duration;
			}
			free(weight_times);
			free(weights);
		}
	}

	// A clip lasts as long as its take even if its last keys were reduced away, or every track only
	// held the rest pose: a clip's length is its latest key time, so one held track reaches the end.
	if (latest_key + 1e-4 < duration && baked->key_time_max > baked->key_time_min) {
		for (size_t n = 0; n < baked->nodes.count; n++) {
			const ufbx_baked_node *baked_node = &baked->nodes.data[n];
			int index = g.node_index[baked_node->typed_id];
			if (index < 0 || !baked_node->rotation_keys.count) continue;
			ufbx_quat last = baked_node->rotation_keys.data[baked_node->rotation_keys.count - 1].value;
			float end_times[2] = { 0.0f, (float)duration };
			float end_values[8] = { (float)last.x, (float)last.y, (float)last.z, (float)last.w, (float)last.x, (float)last.y, (float)last.z, (float)last.w };
			// Only when nothing else moves this bone: a second track on it would fight the first.
			bool moved = false;
			if (last_node == index) moved = true;
			if (baked_node->rotation_keys.count > 1 && !baked_node->constant_rotation) moved = true;
			if (moved) continue;
			clip_channel(clip, index, "rotation", end_times, 2, end_values, 16, "VEC4");
			(*track_count)++;
			break;
		}
	}
	#undef ENSURE
	free(times);
	free(values);
	return key_total;
}

static void write_animations(double sample_rate, double key_threshold) {
	ufbx_scene *scene = g.scene;
	bool first_clip = true;
	double rate = sample_rate > 0 ? sample_rate : (scene->settings.frames_per_second >= 30 ? scene->settings.frames_per_second : 30);
	for (size_t s = 0; s < scene->anim_stacks.count; s++) {
		const ufbx_anim_stack *stack = scene->anim_stacks.data[s];
		size_t props = 0;
		for (size_t l = 0; l < stack->layers.count; l++) props += stack->layers.data[l]->anim_props.count;
		if (!props) continue;

		ufbx_bake_opts options;
		memset(&options, 0, sizeof(options));
		options.trim_start_time = true;
		options.resample_rate = rate;
		options.minimum_sample_rate = 19.5;
		if (key_threshold > 0) {
			options.key_reduction_enabled = true;
			options.key_reduction_rotation = true;
			options.key_reduction_threshold = key_threshold;
		}
		ufbx_error error;
		ufbx_baked_anim *baked = ufbx_bake_anim(scene, stack->anim, &options, &error);
		if (!baked) continue;

		// The take's own range, or the keys' when the take does not say.
		double duration = baked->playback_duration;
		double key_span = baked->key_time_max - (baked->key_time_min < 0 ? baked->key_time_min : 0);
		if (duration <= 0) duration = key_span;

		Buffer channels = { 0 }, samplers = { 0 };
		ClipWriter clip;
		memset(&clip, 0, sizeof(clip));
		clip.channels = &channels;
		clip.samplers = &samplers;
		json_raw(&channels, "[");
		json_raw(&samplers, "[");
		size_t tracks = 0;
		size_t keys = write_clip_tracks(&clip, baked, stack, rate, duration, &tracks);
		json_raw(&channels, "]");
		json_raw(&samplers, "]");

		if (tracks) {
			if (!first_clip) json_raw(&g.animations, ",");
			first_clip = false;
			json_raw(&g.animations, "{\"name\":");
			json_string(&g.animations, stack->name);
			json_raw(&g.animations, ",\"channels\":");
			buffer_write(&g.animations, channels.data, channels.length);
			json_raw(&g.animations, ",\"samplers\":");
			buffer_write(&g.animations, samplers.data, samplers.length);
			json_raw(&g.animations, "}");

			if (g.clip_count++) json_raw(&g.clip_report, ",");
			json_raw(&g.clip_report, "{");
			json_key_string(&g.clip_report, "name", stack->name);
			json_key_number(&g.clip_report, "duration", duration);
			json_key_number(&g.clip_report, "start", stack->time_begin);
			json_key_integer(&g.clip_report, "tracks", (long long)tracks);
			json_key_integer(&g.clip_report, "keys", (long long)keys);
			json_key_integer(&g.clip_report, "layers", (long long)stack->layers.count);
			json_raw(&g.clip_report, "}");
		}
		for (size_t i = 0; i < clip.time_used; i++) free(clip.time_values[i]);
		free(clip.time_accessors);
		free(clip.time_values);
		free(clip.time_counts);
		buffer_free(&channels);
		buffer_free(&samplers);
		ufbx_free_baked_anim(baked);
	}
}

// --- What the file holds ---

static const char *axis_name(ufbx_coordinate_axis axis) {
	switch (axis) {
	case UFBX_COORDINATE_AXIS_POSITIVE_X: return "+X";
	case UFBX_COORDINATE_AXIS_NEGATIVE_X: return "-X";
	case UFBX_COORDINATE_AXIS_POSITIVE_Y: return "+Y";
	case UFBX_COORDINATE_AXIS_NEGATIVE_Y: return "-Y";
	case UFBX_COORDINATE_AXIS_POSITIVE_Z: return "+Z";
	case UFBX_COORDINATE_AXIS_NEGATIVE_Z: return "-Z";
	default: return "";
	}
}

static void write_report(Buffer *out) {
	ufbx_scene *scene = g.scene;
	const ufbx_metadata *meta = &scene->metadata;
	const ufbx_scene_settings *settings = &scene->settings;
	json_raw(out, "{");
	json_key(out, "format");
	json_raw(out, meta->file_format == UFBX_FILE_FORMAT_OBJ ? "\"obj\"" : "\"fbx\"");
	json_key_integer(out, "version", meta->version);
	json_key_bool(out, "ascii", meta->ascii);
	json_key_string(out, "creator", meta->creator);
	json_key_string(out, "application", meta->original_application.name);
	json_key(out, "upAxis");
	json_raw(out, "\""); json_raw(out, axis_name(settings->axes.up)); json_raw(out, "\"");
	json_key(out, "frontAxis");
	json_raw(out, "\""); json_raw(out, axis_name(settings->axes.front)); json_raw(out, "\"");
	json_key_number(out, "metresPerUnit", settings->unit_meters);
	json_key_number(out, "framesPerSecond", settings->frames_per_second);

	size_t triangles = 0, vertices = 0, skinned = 0, morphs = 0, ngons = 0, withoutUv = 0, withoutNormals = 0;
	double box_min[3] = { INFINITY, INFINITY, INFINITY };
	double box_max[3] = { -INFINITY, -INFINITY, -INFINITY };
	double rig_min[3] = { INFINITY, INFINITY, INFINITY };
	double rig_max[3] = { -INFINITY, -INFINITY, -INFINITY };
	// The same, of what stays once what the file's names and flags say is taken out.
	double kept_min[3] = { INFINITY, INFINITY, INFINITY };
	double kept_max[3] = { -INFINITY, -INFINITY, -INFINITY };
	double kept_rig_min[3] = { INFINITY, INFINITY, INFINITY };
	double kept_rig_max[3] = { -INFINITY, -INFINITY, -INFINITY };
	for (size_t s = 0; s < scene->skin_deformers.count; s++) {
		int most = (int)scene->skin_deformers.data[s]->max_weights_per_vertex;
		if (most > g.max_influences_in_file) g.max_influences_in_file = most;
	}
	for (size_t m = 0; m < scene->meshes.count; m++) {
		const ufbx_mesh *mesh = scene->meshes.data[m];
		size_t instances = mesh->instances.count ? mesh->instances.count : 1;
		triangles += mesh->num_triangles * instances;
		vertices += mesh->num_vertices;
		if (mesh->skin_deformers.count) skinned++;
		for (size_t b = 0; b < mesh->blend_deformers.count; b++) morphs += mesh->blend_deformers.data[b]->channels.count;
		if (mesh->max_face_triangles > 2) ngons++;
		if (mesh->num_triangles && !mesh->vertex_uv.exists) withoutUv++;
		if (mesh->num_triangles && !mesh->vertex_normal.exists) withoutNormals++;
		const ufbx_skin_deformer *skin = mesh->skin_deformers.count ? mesh->skin_deformers.data[0] : NULL;
		for (size_t i = 0; i < mesh->instances.count; i++) {
			const ufbx_matrix *to_world = &mesh->instances.data[i]->geometry_to_world;
			bool loose = node_is_loose(mesh->instances.data[i]);
			bool left_out = node_is_left_out(mesh->instances.data[i]);
			for (size_t v = 0; v < mesh->num_vertices; v++) {
				// A skinned vertex is where its strongest bone puts it, whatever the mesh node's own transform says.
				const ufbx_matrix *matrix = to_world;
				if (skin && v < skin->vertices.count && skin->vertices.data[v].num_weights) {
					const ufbx_skin_cluster *cluster = skin->clusters.data[skin->weights.data[skin->vertices.data[v].weight_begin].cluster_index];
					matrix = &cluster->geometry_to_world;
				}
				ufbx_vec3 world = ufbx_transform_position(matrix, mesh->vertices.data[v]);
				double p[3] = { world.x, world.y, world.z };
				for (int axis = 0; axis < 3; axis++) {
					if (p[axis] < box_min[axis]) box_min[axis] = p[axis];
					if (p[axis] > box_max[axis]) box_max[axis] = p[axis];
					if (!loose && p[axis] < rig_min[axis]) rig_min[axis] = p[axis];
					if (!loose && p[axis] > rig_max[axis]) rig_max[axis] = p[axis];
					if (left_out) continue;
					if (p[axis] < kept_min[axis]) kept_min[axis] = p[axis];
					if (p[axis] > kept_max[axis]) kept_max[axis] = p[axis];
					if (!loose && p[axis] < kept_rig_min[axis]) kept_rig_min[axis] = p[axis];
					if (!loose && p[axis] > kept_rig_max[axis]) kept_rig_max[axis] = p[axis];
				}
			}
		}
	}
	json_key_integer(out, "meshes", (long long)scene->meshes.count);
	json_key_integer(out, "triangles", (long long)triangles);
	json_key_integer(out, "vertices", (long long)vertices);
	json_key_integer(out, "skinnedMeshes", (long long)skinned);
	json_key_integer(out, "blendShapes", (long long)morphs);
	json_key_integer(out, "meshesWithPolygons", (long long)ngons);
	json_key_integer(out, "meshesWithoutUvs", (long long)withoutUv);
	json_key_integer(out, "meshesWithoutNormals", (long long)withoutNormals);
	// When nothing would stay, it all does.
	bool any_kept = kept_min[0] <= kept_max[0];
	bool any_kept_rig = kept_rig_min[0] <= kept_rig_max[0];
	if (box_min[0] <= box_max[0]) {
		json_key_floats(out, "boundsMin", any_kept ? kept_min : box_min, 3);
		json_key_floats(out, "boundsMax", any_kept ? kept_max : box_max, 3);
	}
	if (rig_min[0] <= rig_max[0]) {
		json_key_floats(out, "boundsWithoutLooseMin", any_kept_rig ? kept_rig_min : rig_min, 3);
		json_key_floats(out, "boundsWithoutLooseMax", any_kept_rig ? kept_rig_max : rig_max, 3);
	}
	json_key(out, "looseMeshes");
	json_raw(out, "[");
	{
		bool first = true;
		for (size_t i = 0; i < scene->nodes.count; i++) {
			const ufbx_node *node = scene->nodes.data[i];
			if (!node_is_loose(node)) continue;
			if (!first) json_raw(out, ",");
			first = false;
			json_raw(out, "{");
			json_key_string(out, "name", node->name);
			json_key_integer(out, "triangles", (long long)node->mesh->num_triangles);
			json_raw(out, "}");
		}
	}
	json_raw(out, "]");

	size_t bones = 0, collision = 0, sockets = 0;
	for (size_t i = 0; i < scene->nodes.count; i++) {
		const ufbx_node *node = scene->nodes.data[i];
		if (node->bone) bones++;
		if (name_is_shape(node->name)) collision++;
		if (name_has_prefix(node->name, "SOCKET_")) sockets++;
	}
	json_key_integer(out, "bones", (long long)bones);
	json_key(out, "boneNames");
	json_raw(out, "[");
	{
		bool first = true;
		for (size_t i = 0; i < scene->nodes.count; i++) {
			const ufbx_node *node = scene->nodes.data[i];
			if (!node->bone) continue;
			if (!first) json_raw(out, ",");
			first = false;
			json_string(out, node->name);
		}
	}
	json_raw(out, "]");
	json_key_integer(out, "collisionMeshes", (long long)collision);
	json_key_integer(out, "sockets", (long long)sockets);
	json_key_integer(out, "lodGroups", (long long)scene->lod_groups.count);
	json_key_integer(out, "cameras", (long long)scene->cameras.count);
	json_key_integer(out, "lights", (long long)scene->lights.count);
	json_key_integer(out, "materials", (long long)scene->materials.count);

	json_key_integer(out, "outputVertices", (long long)g.output_vertices);
	json_key_integer(out, "outputTriangles", (long long)g.output_triangles);
	json_key_integer(out, "tangentsGenerated", (long long)g.tangents_generated);
	json_key_integer(out, "tangentsFromFile", (long long)g.tangents_from_file);
	json_key_integer(out, "partsWithoutTangents", (long long)g.parts_without_tangents);
	json_key_integer(out, "maxInfluences", g.max_influences_in_file);
	json_key_integer(out, "verticesOverInfluenceLimit", (long long)g.vertices_over_influence_limit);
	json_key_integer(out, "verticesWithoutWeights", (long long)g.vertices_without_weights);

	json_key(out, "clips");
	json_raw(out, "[");
	if (g.flags & FLAG_INSPECT) {
		bool first = true;
		for (size_t s = 0; s < scene->anim_stacks.count; s++) {
			const ufbx_anim_stack *stack = scene->anim_stacks.data[s];
			size_t props = 0;
			for (size_t l = 0; l < stack->layers.count; l++) props += stack->layers.data[l]->anim_props.count;
			if (!props) continue;
			if (!first) json_raw(out, ",");
			first = false;
			json_raw(out, "{");
			json_key_string(out, "name", stack->name);
			json_key_number(out, "duration", stack->time_end - stack->time_begin);
			json_key_number(out, "start", stack->time_begin);
			json_key_integer(out, "layers", (long long)stack->layers.count);
			json_raw(out, "}");
		}
	} else if (g.clip_report.length) {
		buffer_write(out, g.clip_report.data, g.clip_report.length);
	}
	json_raw(out, "]");

	json_key(out, "warnings");
	json_raw(out, "[");
	for (size_t i = 0; i < meta->warnings.count; i++) {
		const ufbx_warning *warning = &meta->warnings.data[i];
		if (i) json_raw(out, ",");
		json_string(out, warning->description);
	}
	json_raw(out, "]}");
}

// --- Materials and textures, as the file has them ---

static void json_key_map_value(Buffer *out, const char *key, const ufbx_material_map *map) {
	json_key(out, key);
	if (map->has_value || map->value_components) json_number(out, map->value_real);
	else json_raw(out, "null");
}

static void json_key_map_colour(Buffer *out, const char *key, const ufbx_material_map *map) {
	json_key(out, key);
	if (!map->has_value && !map->value_components) {
		json_raw(out, "null");
		return;
	}
	json_raw(out, "[");
	json_number(out, map->value_vec4.x);
	json_raw(out, ",");
	json_number(out, map->value_vec4.y);
	json_raw(out, ",");
	json_number(out, map->value_vec4.z);
	json_raw(out, ",");
	json_number(out, map->value_components >= 4 ? map->value_vec4.w : 1.0);
	json_raw(out, "]");
}

/** The index of the file texture a map uses, or -1: a layered texture stands for its first file. */
static void json_key_texture(Buffer *out, const char *key, const ufbx_material_map *map) {
	const ufbx_texture *texture = map->texture;
	if (texture && !map->texture_enabled && map->feature_disabled) texture = NULL;
	if (texture && texture->type != UFBX_TEXTURE_FILE) texture = texture->file_textures.count ? texture->file_textures.data[0] : NULL;
	if (!texture) return;
	json_key_integer(out, key, texture->typed_id);
}

static void write_materials(Buffer *out) {
	ufbx_scene *scene = g.scene;
	json_raw(out, "[");
	for (size_t i = 0; i < scene->materials.count; i++) {
		const ufbx_material *material = scene->materials.data[i];
		const ufbx_material_pbr_maps *pbr = &material->pbr;
		const ufbx_material_fbx_maps *fbx = &material->fbx;
		if (i) json_raw(out, ",");
		json_raw(out, "{");
		json_key_string(out, "name", material->name);
		json_key_integer(out, "shader", material->shader_type);
		json_key_map_colour(out, "baseColor", &pbr->base_color);
		json_key_map_value(out, "baseFactor", &pbr->base_factor);
		json_key_texture(out, "baseTexture", &pbr->base_color);
		json_key_map_value(out, "roughness", &pbr->roughness);
		json_key_texture(out, "roughnessTexture", &pbr->roughness);
		json_key_map_value(out, "glossiness", &pbr->glossiness);
		json_key_texture(out, "glossinessTexture", &pbr->glossiness);
		json_key_map_value(out, "metalness", &pbr->metalness);
		json_key_texture(out, "metalnessTexture", &pbr->metalness);
		json_key_texture(out, "normalTexture", pbr->normal_map.texture ? &pbr->normal_map : &fbx->normal_map);
		json_key_texture(out, "bumpTexture", &fbx->bump);
		json_key_texture(out, "occlusionTexture", &pbr->ambient_occlusion);
		json_key_map_colour(out, "emission", &pbr->emission_color);
		json_key_map_value(out, "emissionFactor", &pbr->emission_factor);
		json_key_texture(out, "emissionTexture", &pbr->emission_color);
		json_key_map_value(out, "opacity", &pbr->opacity);
		json_key_texture(out, "opacityTexture", pbr->opacity.texture ? &pbr->opacity : &fbx->transparency_color);
		json_key_number(out, "opacityProperty", ufbx_find_real(&material->props, "Opacity", -1.0));
		json_key_bool(out, "unlit", material->features.unlit.enabled);
		json_key_bool(out, "doubleSided", material->features.double_sided.enabled);
		json_raw(out, "}");
	}
	json_raw(out, "]");
}

static void write_textures(Buffer *out) {
	ufbx_scene *scene = g.scene;
	json_raw(out, "[");
	for (size_t i = 0; i < scene->textures.count; i++) {
		const ufbx_texture *texture = scene->textures.data[i];
		if (i) json_raw(out, ",");
		json_raw(out, "{");
		json_key_string(out, "name", texture->name);
		json_key_string(out, "file", texture->relative_filename.length ? texture->relative_filename : texture->filename);
		json_key_string(out, "absoluteFile", texture->absolute_filename);
		json_key_integer(out, "pointer", (long long)(uintptr_t)texture->content.data);
		json_key_integer(out, "size", (long long)texture->content.size);
		json_key_string(out, "uvSet", texture->uv_set);
		json_key_integer(out, "wrapU", texture->wrap_u);
		json_key_integer(out, "wrapV", texture->wrap_v);
		if (texture->has_uv_transform) {
			// Scaling is how many times the image repeats, as art tools and engines read it: texture
			// coordinate = uv * scale + offset. ufbx's own uv_to_texture is the inverse of that.
			double offset[2] = { texture->uv_transform.translation.x, texture->uv_transform.translation.y };
			double scale[2] = { texture->uv_transform.scale.x, texture->uv_transform.scale.y };
			json_key_floats(out, "uvOffset", offset, 2);
			json_key_floats(out, "uvScale", scale, 2);
		}
		json_raw(out, "}");
	}
	json_raw(out, "]");
}

/** Each mesh's UV sets by name, for a material to say which one a texture reads. */
static void write_uv_sets(Buffer *out) {
	ufbx_scene *scene = g.scene;
	json_raw(out, "[");
	bool first = true;
	for (int at = 0; at < g.mesh_source_count; at++) {
		if (!first) json_raw(out, ",");
		first = false;
		json_raw(out, "[");
		const ufbx_mesh *mesh = scene->meshes.data[g.mesh_source[at]];
		for (size_t u = 0; u < mesh->uv_sets.count && u < MAX_UV_SETS; u++) {
			if (u) json_raw(out, ",");
			json_string(out, mesh->uv_sets.data[u].name);
		}
		json_raw(out, "]");
	}
	json_raw(out, "]");
}

static void write_document(void) {
	Buffer *out = &g.json;
	ufbx_scene *scene = g.scene;
	json_raw(out, "{");
	json_key(out, "report");
	write_report(out);
	json_key(out, "materials");
	write_materials(out);
	json_key(out, "textures");
	write_textures(out);
	json_key(out, "meshUvSets");
	write_uv_sets(out);
	json_key(out, "document");
	json_raw(out, "{");
	json_key(out, "nodes");
	json_raw(out, "[");
	if (g.nodes.length) buffer_write(out, g.nodes.data, g.nodes.length);
	json_raw(out, "]");
	json_key(out, "scene");
	json_raw(out, "0");
	json_key(out, "scenes");
	json_raw(out, "[{\"nodes\":[");
	// The kept root, or else what sits directly under it.
	int root = g.node_index[scene->root_node->typed_id];
	if (root >= 0) {
		json_integer(out, root);
	} else {
		bool first = true;
		for (size_t c = 0; c < scene->root_node->children.count; c++) {
			int child = g.node_index[scene->root_node->children.data[c]->typed_id];
			if (child < 0) continue;
			if (!first) json_raw(out, ",");
			first = false;
			json_integer(out, child);
		}
	}
	json_raw(out, "]}]");
	if (g.meshes.length) { json_key(out, "meshes"); json_raw(out, "["); buffer_write(out, g.meshes.data, g.meshes.length); json_raw(out, "]"); }
	if (g.skins.length) { json_key(out, "skins"); json_raw(out, "["); buffer_write(out, g.skins.data, g.skins.length); json_raw(out, "]"); }
	if (g.animations.length) { json_key(out, "animations"); json_raw(out, "["); buffer_write(out, g.animations.data, g.animations.length); json_raw(out, "]"); }
	json_key(out, "accessors");
	json_raw(out, "[");
	if (g.accessors.length) buffer_write(out, g.accessors.data, g.accessors.length);
	json_raw(out, "]");
	json_key(out, "bufferViews");
	json_raw(out, "[");
	if (g.views.length) buffer_write(out, g.views.data, g.views.length);
	json_raw(out, "]}}");
}

// --- The interface ---

EXPORT("fbx_malloc") void *fbx_malloc(size_t size) { return malloc(size); }
EXPORT("fbx_free") void fbx_free(void *block) { free(block); }

EXPORT("fbx_close") void fbx_close(void) { import_free(); }

/**
 * Reads a file and builds the import. Returns 1, or 0 with fbx_error_* set. `data` comes from
 * fbx_malloc and is taken over: it is freed as soon as the file is read, as a big file needs the
 * room. So is `materials`, an OBJ's .mtl file, if there is one. Everything else stays readable until
 * fbx_close.
 */
EXPORT("fbx_import") int fbx_import(void *data, size_t size, const char *name, size_t name_length, int flags, double sample_rate, double key_threshold, double smoothing_angle, void *materials, size_t materials_size) {
	import_free();
	g.flags = flags;
	g.smoothing_angle = smoothing_angle > 0 ? smoothing_angle : 60.0;

	ufbx_load_opts options;
	memset(&options, 0, sizeof(options));
	options.target_axes = ufbx_axes_right_handed_y_up;
	options.space_conversion = UFBX_SPACE_CONVERSION_TRANSFORM_ROOT;
	// Units stay as the file has them: the model root carries the conversion to metres.
	options.geometry_transform_handling = UFBX_GEOMETRY_TRANSFORM_HANDLING_MODIFY_GEOMETRY;
	options.inherit_mode_handling = UFBX_INHERIT_MODE_HANDLING_COMPENSATE;
	options.clean_skin_weights = true;
	options.use_blender_pbr_material = true;
	options.normalize_normals = true;
	options.normalize_tangents = true;
	options.ignore_missing_external_files = true;
	options.filename.data = name;
	options.filename.length = name_length;
	options.path_separator = '/';
	if (flags & FLAG_OBJ) options.file_format = UFBX_FILE_FORMAT_OBJ;
	if (flags & FLAG_NO_ANIMATION) options.ignore_animation = true;
	if (materials) {
		options.obj_mtl_data.data = materials;
		options.obj_mtl_data.size = materials_size;
	}

	ufbx_error error;
	g.scene = ufbx_load_memory(data, size, &options, &error);
	free(data);
	free(materials);
	if (!g.scene) {
		size_t written = ufbx_format_error(g.error, sizeof(g.error), &error);
		char *first_line = memchr(g.error, '\n', written);
		g.error_length = first_line ? (size_t)(first_line - g.error) : written;
		if (error.description.length && error.description.length < sizeof(g.error)) {
			memcpy(g.error, error.description.data, error.description.length);
			g.error_length = error.description.length;
		}
		return 0;
	}

	ufbx_scene *scene = g.scene;
	for (size_t m = 0; m < scene->meshes.count && !g.has_skin; m++) {
		const ufbx_mesh *mesh = scene->meshes.data[m];
		for (size_t d = 0; d < mesh->skin_deformers.count; d++) if (mesh->skin_deformers.data[d]->clusters.count) g.has_skin = true;
	}
	g.node_index = checked_malloc(scene->nodes.count * sizeof(int));
	g.mesh_index = checked_malloc((scene->meshes.count + 1) * sizeof(int));
	g.skin_index = checked_malloc((scene->skin_deformers.count + 1) * sizeof(int));
	memset(g.mesh_index, 0xff, (scene->meshes.count + 1) * sizeof(int));
	g.node_mesh = checked_malloc((scene->nodes.count + 1) * sizeof(int));
	memset(g.node_mesh, 0xff, (scene->nodes.count + 1) * sizeof(int));
	memset(g.skin_index, 0xff, (scene->skin_deformers.count + 1) * sizeof(int));

	number_nodes();
	if (!(flags & FLAG_INSPECT)) {
		if (!(flags & FLAG_NO_MESHES)) write_meshes();
		if (!(flags & (FLAG_NO_SKIN | FLAG_NO_MESHES))) write_skins();
		write_nodes();
		if (!(flags & FLAG_NO_ANIMATION)) write_animations(sample_rate, key_threshold);
	}
	write_document();
	return 1;
}

EXPORT("fbx_error_pointer") const char *fbx_error_pointer(void) { return g.error; }
EXPORT("fbx_error_length") size_t fbx_error_length(void) { return g.error_length; }
EXPORT("fbx_json_pointer") const char *fbx_json_pointer(void) { return g.json.data; }
EXPORT("fbx_json_length") size_t fbx_json_length(void) { return g.json.length; }
EXPORT("fbx_binary_pointer") const char *fbx_binary_pointer(void) { return g.binary.data; }
EXPORT("fbx_binary_length") size_t fbx_binary_length(void) { return g.binary.length; }
