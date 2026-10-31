// Tool input snapshots for the stateful protocol double; checked against the server by handover.test.ts.
export const WORLD_TOOLS = [
  {
    "name": "wait_for_my_tasks",
    "inputSchema": {
      "type": "object",
      "properties": {
        "after": {
          "type": "string"
        },
        "timeout_s": {
          "type": "integer",
          "minimum": 0,
          "maximum": 120,
          "default": 50
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "claim_task",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string"
        },
        "harness": {
          "type": "string",
          "minLength": 1,
          "maxLength": 60,
          "description": "claude_code, codex, chatgpt, claude_ai, custom…"
        },
        "external_session_id": {
          "type": "string",
          "maxLength": 200,
          "description": "Your harness session id. Codex: the value of the CODEX_THREAD_ID environment variable. It lets corrections reach this same session."
        },
        "resume": {
          "type": "boolean",
          "description": "Continue from the last checkpoint: returns it, classified by the server."
        }
      },
      "required": [
        "harness"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "heartbeat",
    "inputSchema": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "minLength": 1
        },
        "after_seq": {
          "type": "integer",
          "minimum": 0
        },
        "usage": {
          "type": "object",
          "properties": {
            "input_tokens": {
              "type": "integer",
              "minimum": 0
            },
            "output_tokens": {
              "type": "integer",
              "minimum": 0
            },
            "model": {
              "type": "string"
            },
            "cost_usd": {
              "type": "number",
              "minimum": 0
            }
          },
          "required": [
            "input_tokens",
            "output_tokens"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "run_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "wait_for_task",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "minLength": 1
        },
        "after_seq": {
          "type": "integer",
          "minimum": 0
        },
        "timeout_s": {
          "type": "integer",
          "minimum": 0,
          "maximum": 120,
          "default": 50
        },
        "run_id": {
          "type": "string"
        }
      },
      "required": [
        "task_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "get_task",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "minLength": 1
        },
        "activities_limit": {
          "type": "integer",
          "minimum": 0,
          "maximum": 200,
          "default": 20
        },
        "after_seq": {
          "type": "integer",
          "minimum": 0,
          "description": "Only activities after this seq, oldest first; omit for the last activities_limit."
        },
        "include_ephemeral": {
          "type": "boolean"
        }
      },
      "required": [
        "task_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "read_page",
    "inputSchema": {
      "type": "object",
      "properties": {
        "page_id": {
          "type": "string",
          "minLength": 1
        },
        "cursor": {
          "type": "string"
        },
        "max_blocks": {
          "type": "integer",
          "minimum": 1,
          "maximum": 500,
          "default": 200
        },
        "include_comments": {
          "type": "boolean"
        }
      },
      "required": [
        "page_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "append_blocks",
    "inputSchema": {
      "type": "object",
      "properties": {
        "page_id": {
          "type": "string",
          "minLength": 1
        },
        "markdown": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200000
        },
        "blocks": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/AgentBlockInput"
          },
          "minItems": 1,
          "maxItems": 500
        },
        "after_block_id": {
          "type": "string"
        },
        "idempotency_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Retry-safe key: the same key returns the first result."
        }
      },
      "required": [
        "page_id"
      ],
      "additionalProperties": false,
      "$defs": {
        "AgentSpan": {
          "description": "Inline content: plain text, formatted text, a page or person mention, or an inline equation.",
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "object",
              "properties": {
                "text": {
                  "type": "string"
                },
                "bold": {
                  "type": "boolean"
                },
                "italic": {
                  "type": "boolean"
                },
                "code": {
                  "type": "boolean"
                },
                "strike": {
                  "type": "boolean"
                },
                "underline": {
                  "type": "boolean"
                },
                "href": {
                  "type": "string",
                  "description": "http, https, mailto or tel; other schemes are dropped."
                }
              },
              "required": [
                "text"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "mention": {
                  "const": "page"
                },
                "pageId": {
                  "type": "string"
                }
              },
              "required": [
                "mention",
                "pageId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "mention": {
                  "const": "person"
                },
                "userId": {
                  "type": "string"
                }
              },
              "required": [
                "mention",
                "userId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "equation": {
                  "type": "string"
                }
              },
              "required": [
                "equation"
              ],
              "additionalProperties": false
            }
          ]
        },
        "AgentBlockInput": {
          "type": "object",
          "description": "One block. Agents never send HTML; the server builds it from spans.",
          "properties": {
            "type": {
              "type": "string",
              "enum": [
                "paragraph",
                "heading1",
                "heading2",
                "heading3",
                "todo",
                "bulleted",
                "numbered",
                "toggle",
                "quote",
                "callout",
                "code",
                "divider",
                "equation",
                "bookmark",
                "image",
                "file",
                "page"
              ]
            },
            "spans": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/AgentSpan"
              },
              "description": "Inline content; literal text for code."
            },
            "indent": {
              "type": "integer",
              "minimum": 0,
              "maximum": 6
            },
            "checked": {
              "type": "boolean"
            },
            "language": {
              "type": "string"
            },
            "icon": {
              "type": "string"
            },
            "url": {
              "type": "string"
            },
            "caption": {
              "type": "string"
            },
            "equation": {
              "type": "string"
            },
            "pageId": {
              "type": "string"
            },
            "color": {
              "type": "string",
              "enum": [
                "default",
                "gray",
                "brown",
                "orange",
                "yellow",
                "green",
                "blue",
                "purple",
                "pink",
                "red",
                "bg-gray",
                "bg-brown",
                "bg-orange",
                "bg-yellow",
                "bg-green",
                "bg-blue",
                "bg-purple",
                "bg-pink",
                "bg-red"
              ]
            },
            "key": {
              "type": "string",
              "pattern": "^[A-Za-z0-9_.:-]{1,64}$",
              "description": "Stable section key the app reads back, e.g. \"brief:goal\"."
            }
          },
          "required": [
            "type"
          ],
          "additionalProperties": false
        },
        "AgentCellInput": {
          "description": "A cell value; the key matches the property type. select/status/multiSelect take option names.",
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "text": {
                  "type": "string"
                }
              },
              "required": [
                "text"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "number": {
                  "type": "number"
                }
              },
              "required": [
                "number"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "checkbox": {
                  "type": "boolean"
                }
              },
              "required": [
                "checkbox"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "date": {
                  "type": "string",
                  "description": "ISO date or date-time"
                },
                "end": {
                  "type": "string"
                }
              },
              "required": [
                "date"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "select": {
                  "type": "string"
                }
              },
              "required": [
                "select"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "status": {
                  "type": "string"
                }
              },
              "required": [
                "status"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "multiSelect": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              },
              "required": [
                "multiSelect"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "url": {
                  "type": "string"
                }
              },
              "required": [
                "url"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "email": {
                  "type": "string"
                }
              },
              "required": [
                "email"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "phone": {
                  "type": "string"
                }
              },
              "required": [
                "phone"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "relation": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "Page ids"
                }
              },
              "required": [
                "relation"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "person": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "User ids"
                }
              },
              "required": [
                "person"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "files": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              },
              "required": [
                "files"
              ],
              "additionalProperties": false
            }
          ]
        }
      }
    }
  },
  {
    "name": "edit_page",
    "inputSchema": {
      "type": "object",
      "properties": {
        "page_id": {
          "type": "string",
          "minLength": 1
        },
        "old_str": {
          "type": "string",
          "minLength": 1,
          "maxLength": 5000
        },
        "new_str": {
          "type": "string",
          "maxLength": 5000
        },
        "block_id": {
          "type": "string"
        },
        "rev": {
          "type": "integer",
          "minimum": 0
        },
        "idempotency_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Retry-safe key: the same key returns the first result."
        }
      },
      "required": [
        "page_id",
        "old_str",
        "new_str"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "request_approval",
    "inputSchema": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "minLength": 1
        },
        "action": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "params": {
          "type": "object"
        },
        "question": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4000
        },
        "artifact_id": {
          "type": "string"
        }
      },
      "required": [
        "run_id",
        "action",
        "params",
        "question"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "begin_external_op",
    "inputSchema": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "minLength": 1
        },
        "provider": {
          "type": "string",
          "minLength": 1
        },
        "action": {
          "type": "string",
          "minLength": 1
        },
        "params": {
          "type": "object"
        },
        "approval_receipt": {
          "type": "string"
        }
      },
      "required": [
        "run_id",
        "provider",
        "action",
        "params"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "finish_external_op",
    "inputSchema": {
      "type": "object",
      "properties": {
        "op_id": {
          "type": "string",
          "minLength": 1
        },
        "status": {
          "type": "string",
          "enum": [
            "done",
            "unknown",
            "failed"
          ]
        },
        "provider_ref": {
          "type": "string"
        },
        "error": {
          "type": "string"
        }
      },
      "required": [
        "op_id",
        "status"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "add_artifact",
    "inputSchema": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "minLength": 1
        },
        "kind": {
          "type": "string",
          "enum": [
            "page",
            "file",
            "diff",
            "query",
            "image",
            "external"
          ]
        },
        "ref": {
          "type": "string",
          "minLength": 1,
          "description": "Page id, file id or URL"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        },
        "satisfies": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "content_hash": {
          "type": "string"
        }
      },
      "required": [
        "run_id",
        "kind",
        "ref",
        "title",
        "satisfies"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "submit_for_review",
    "inputSchema": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "minLength": 1
        },
        "summary": {
          "type": "string",
          "minLength": 1,
          "maxLength": 10000
        },
        "artifact_ids": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "minItems": 1
        }
      },
      "required": [
        "run_id",
        "summary",
        "artifact_ids"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "end_run",
    "inputSchema": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "minLength": 1
        },
        "status": {
          "type": "string",
          "enum": [
            "completed",
            "error",
            "cancelled"
          ]
        },
        "error": {
          "type": "string"
        },
        "terminal": {
          "type": "boolean"
        },
        "usage": {
          "type": "object",
          "properties": {
            "input_tokens": {
              "type": "integer",
              "minimum": 0
            },
            "output_tokens": {
              "type": "integer",
              "minimum": 0
            },
            "model": {
              "type": "string"
            },
            "cost_usd": {
              "type": "number",
              "minimum": 0
            }
          },
          "required": [
            "input_tokens",
            "output_tokens"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "run_id",
        "status"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "ack_stop",
    "inputSchema": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "run_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "save_checkpoint",
    "inputSchema": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "minLength": 1
        },
        "checkpoint": {
          "type": "object",
          "properties": {
            "v": {
              "type": "integer",
              "const": 1
            },
            "next_step": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2000
            },
            "ops": {
              "type": "object",
              "properties": {
                "confirmed": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "key": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "tool": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 60
                      },
                      "summary": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 280
                      },
                      "page_id": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 64
                      },
                      "block_ids": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 64
                        },
                        "maxItems": 200
                      },
                      "args_hash": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 128
                      }
                    },
                    "required": [
                      "key",
                      "tool"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 200
                },
                "pending": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "key": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "tool": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 60
                      },
                      "summary": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 280
                      },
                      "page_id": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 64
                      },
                      "block_ids": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 64
                        },
                        "maxItems": 200
                      },
                      "args_hash": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 128
                      }
                    },
                    "required": [
                      "key",
                      "tool"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 200
                }
              },
              "required": [],
              "additionalProperties": false
            },
            "effects": {
              "type": "object",
              "properties": {
                "confirmed": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "action": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "summary": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 280
                      },
                      "external_op_id": {
                        "type": "string",
                        "format": "uuid"
                      },
                      "approval_id": {
                        "type": "string",
                        "format": "uuid"
                      }
                    },
                    "required": [
                      "action"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 50
                },
                "not_executed": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "action": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "summary": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 280
                      },
                      "external_op_id": {
                        "type": "string",
                        "format": "uuid"
                      },
                      "approval_id": {
                        "type": "string",
                        "format": "uuid"
                      }
                    },
                    "required": [
                      "action"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 50
                },
                "unknown": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "action": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "summary": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 280
                      },
                      "external_op_id": {
                        "type": "string",
                        "format": "uuid"
                      },
                      "approval_id": {
                        "type": "string",
                        "format": "uuid"
                      }
                    },
                    "required": [
                      "action"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 50
                }
              },
              "required": [],
              "additionalProperties": false
            },
            "evidence": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "criterion_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 60
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "met",
                      "unmet",
                      "unknown"
                    ]
                  },
                  "refs": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 0,
                      "maxLength": 500
                    },
                    "maxItems": 20
                  },
                  "note": {
                    "type": "string",
                    "minLength": 0,
                    "maxLength": 1000
                  }
                },
                "required": [
                  "criterion_id",
                  "status"
                ],
                "additionalProperties": false
              },
              "maxItems": 50
            },
            "handover_note": {
              "type": "string",
              "minLength": 0,
              "maxLength": 4000
            }
          },
          "required": [
            "v",
            "next_step"
          ],
          "additionalProperties": false
        },
        "idempotency_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        }
      },
      "required": [
        "run_id",
        "checkpoint",
        "idempotency_key"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "hand_over",
    "inputSchema": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "minLength": 1
        },
        "checkpoint": {
          "type": "object",
          "properties": {
            "v": {
              "type": "integer",
              "const": 1
            },
            "next_step": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2000
            },
            "ops": {
              "type": "object",
              "properties": {
                "confirmed": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "key": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "tool": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 60
                      },
                      "summary": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 280
                      },
                      "page_id": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 64
                      },
                      "block_ids": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 64
                        },
                        "maxItems": 200
                      },
                      "args_hash": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 128
                      }
                    },
                    "required": [
                      "key",
                      "tool"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 200
                },
                "pending": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "key": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "tool": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 60
                      },
                      "summary": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 280
                      },
                      "page_id": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 64
                      },
                      "block_ids": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 64
                        },
                        "maxItems": 200
                      },
                      "args_hash": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 128
                      }
                    },
                    "required": [
                      "key",
                      "tool"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 200
                }
              },
              "required": [],
              "additionalProperties": false
            },
            "effects": {
              "type": "object",
              "properties": {
                "confirmed": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "action": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "summary": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 280
                      },
                      "external_op_id": {
                        "type": "string",
                        "format": "uuid"
                      },
                      "approval_id": {
                        "type": "string",
                        "format": "uuid"
                      }
                    },
                    "required": [
                      "action"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 50
                },
                "not_executed": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "action": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "summary": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 280
                      },
                      "external_op_id": {
                        "type": "string",
                        "format": "uuid"
                      },
                      "approval_id": {
                        "type": "string",
                        "format": "uuid"
                      }
                    },
                    "required": [
                      "action"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 50
                },
                "unknown": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "action": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "summary": {
                        "type": "string",
                        "minLength": 0,
                        "maxLength": 280
                      },
                      "external_op_id": {
                        "type": "string",
                        "format": "uuid"
                      },
                      "approval_id": {
                        "type": "string",
                        "format": "uuid"
                      }
                    },
                    "required": [
                      "action"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 50
                }
              },
              "required": [],
              "additionalProperties": false
            },
            "evidence": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "criterion_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 60
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "met",
                      "unmet",
                      "unknown"
                    ]
                  },
                  "refs": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 0,
                      "maxLength": 500
                    },
                    "maxItems": 20
                  },
                  "note": {
                    "type": "string",
                    "minLength": 0,
                    "maxLength": 1000
                  }
                },
                "required": [
                  "criterion_id",
                  "status"
                ],
                "additionalProperties": false
              },
              "maxItems": 50
            },
            "handover_note": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4000
            }
          },
          "required": [
            "v",
            "next_step",
            "handover_note"
          ],
          "additionalProperties": false
        },
        "idempotency_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        }
      },
      "required": [
        "run_id",
        "checkpoint",
        "idempotency_key"
      ],
      "additionalProperties": false
    }
  }
];
