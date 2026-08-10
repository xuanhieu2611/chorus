export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      agent_events: {
        Row: {
          agent: string
          agent_run_id: string | null
          campaign_id: string
          created_at: string
          data: Json | null
          id: number
          level: string
          message: string
          node: string | null
        }
        Insert: {
          agent: string
          agent_run_id?: string | null
          campaign_id: string
          created_at?: string
          data?: Json | null
          id?: never
          level?: string
          message: string
          node?: string | null
        }
        Update: {
          agent?: string
          agent_run_id?: string | null
          campaign_id?: string
          created_at?: string
          data?: Json | null
          id?: never
          level?: string
          message?: string
          node?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_events_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_events_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          agent: string
          campaign_id: string
          completion_tokens: number | null
          cost_usd: number | null
          error: string | null
          finished_at: string | null
          id: string
          input: Json | null
          model: string | null
          node: string
          output: Json | null
          prompt_tokens: number | null
          started_at: string
          status: string
          tool_calls: Json
        }
        Insert: {
          agent: string
          campaign_id: string
          completion_tokens?: number | null
          cost_usd?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json | null
          model?: string | null
          node: string
          output?: Json | null
          prompt_tokens?: number | null
          started_at?: string
          status?: string
          tool_calls?: Json
        }
        Update: {
          agent?: string
          campaign_id?: string
          completion_tokens?: number | null
          cost_usd?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json | null
          model?: string | null
          node?: string
          output?: Json | null
          prompt_tokens?: number | null
          started_at?: string
          status?: string
          tool_calls?: Json
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          campaign_id: string
          content: Json | null
          created_at: string
          duration_sec: number | null
          hook: string | null
          id: string
          media_path: string | null
          media_url: string | null
          plan_key: string
          platform: string
          revision_count: number
          source_segment_ids: string[]
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          campaign_id: string
          content?: Json | null
          created_at?: string
          duration_sec?: number | null
          hook?: string | null
          id?: string
          media_path?: string | null
          media_url?: string | null
          plan_key: string
          platform: string
          revision_count?: number
          source_segment_ids?: string[]
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          campaign_id?: string
          content?: Json | null
          created_at?: string
          duration_sec?: number | null
          hook?: string | null
          id?: string
          media_path?: string | null
          media_url?: string | null
          plan_key?: string
          platform?: string
          revision_count?: number
          source_segment_ids?: string[]
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assets_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_reviews: {
        Row: {
          campaign_id: string
          created_at: string
          decision: string
          id: string
          problems: Json
          recommendations: Json
          scores: Json
          version: number
        }
        Insert: {
          campaign_id: string
          created_at?: string
          decision: string
          id?: string
          problems?: Json
          recommendations?: Json
          scores: Json
          version: number
        }
        Update: {
          campaign_id?: string
          created_at?: string
          decision?: string
          id?: string
          problems?: Json
          recommendations?: Json
          scores?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "campaign_reviews_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          audience: string | null
          brand_voice: string | null
          claimed_at: string | null
          claimed_by: string | null
          cost_usd: number
          created_at: string
          credit_budget: number
          credits_spent: number
          current_node: string | null
          error: string | null
          goal: string
          has_video_stream: boolean | null
          heartbeat_at: string | null
          id: string
          max_assets: number
          max_video_seconds: number
          platforms: string[]
          replan_count: number
          source_duration_sec: number | null
          source_path: string | null
          status: string
          title: string | null
          updated_at: string
        }
        Insert: {
          audience?: string | null
          brand_voice?: string | null
          claimed_at?: string | null
          claimed_by?: string | null
          cost_usd?: number
          created_at?: string
          credit_budget?: number
          credits_spent?: number
          current_node?: string | null
          error?: string | null
          goal: string
          has_video_stream?: boolean | null
          heartbeat_at?: string | null
          id?: string
          max_assets?: number
          max_video_seconds?: number
          platforms?: string[]
          replan_count?: number
          source_duration_sec?: number | null
          source_path?: string | null
          status?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          audience?: string | null
          brand_voice?: string | null
          claimed_at?: string | null
          claimed_by?: string | null
          cost_usd?: number
          created_at?: string
          credit_budget?: number
          credits_spent?: number
          current_node?: string | null
          error?: string | null
          goal?: string
          has_video_stream?: boolean | null
          heartbeat_at?: string | null
          id?: string
          max_assets?: number
          max_video_seconds?: number
          platforms?: string[]
          replan_count?: number
          source_duration_sec?: number | null
          source_path?: string | null
          status?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      reviews: {
        Row: {
          asset_id: string
          campaign_id: string
          created_at: string
          decision: string
          feedback: string
          id: string
          reviewer_agent: string
          revision_index: number
          scores: Json
        }
        Insert: {
          asset_id: string
          campaign_id: string
          created_at?: string
          decision: string
          feedback: string
          id?: string
          reviewer_agent?: string
          revision_index?: number
          scores: Json
        }
        Update: {
          asset_id?: string
          campaign_id?: string
          created_at?: string
          decision?: string
          feedback?: string
          id?: string
          reviewer_agent?: string
          revision_index?: number
          scores?: Json
        }
        Relationships: [
          {
            foreignKeyName: "reviews_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      segments: {
        Row: {
          campaign_id: string
          content_type: string
          context_deps: string | null
          created_at: string
          end_time: number
          energy: number | null
          id: string
          novelty_score: number | null
          potential_hooks: string[]
          standalone_score: number | null
          start_time: number
          summary: string | null
          topic: string
          transcript: string
        }
        Insert: {
          campaign_id: string
          content_type: string
          context_deps?: string | null
          created_at?: string
          end_time: number
          energy?: number | null
          id?: string
          novelty_score?: number | null
          potential_hooks?: string[]
          standalone_score?: number | null
          start_time: number
          summary?: string | null
          topic: string
          transcript: string
        }
        Update: {
          campaign_id?: string
          content_type?: string
          context_deps?: string | null
          created_at?: string
          end_time?: number
          energy?: number | null
          id?: string
          novelty_score?: number | null
          potential_hooks?: string[]
          standalone_score?: number | null
          start_time?: number
          summary?: string | null
          topic?: string
          transcript?: string
        }
        Relationships: [
          {
            foreignKeyName: "segments_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      strategies: {
        Row: {
          approved_by: string | null
          campaign_id: string
          created_at: string
          id: string
          planned_assets: Json
          rationale: string
          rejected_topics: Json
          selected_topics: Json
          version: number
        }
        Insert: {
          approved_by?: string | null
          campaign_id: string
          created_at?: string
          id?: string
          planned_assets: Json
          rationale: string
          rejected_topics: Json
          selected_topics: Json
          version: number
        }
        Update: {
          approved_by?: string | null
          campaign_id?: string
          created_at?: string
          id?: string
          planned_assets?: Json
          rationale?: string
          rejected_topics?: Json
          selected_topics?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "strategies_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      transcripts: {
        Row: {
          campaign_id: string
          created_at: string
          language: string | null
          provider: string
          text: string
          words: Json
        }
        Insert: {
          campaign_id: string
          created_at?: string
          language?: string | null
          provider?: string
          text: string
          words: Json
        }
        Update: {
          campaign_id?: string
          created_at?: string
          language?: string | null
          provider?: string
          text?: string
          words?: Json
        }
        Relationships: [
          {
            foreignKeyName: "transcripts_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: true
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_campaign_cost: {
        Args: { p_campaign_id: string; p_cost: number }
        Returns: number
      }
      claim_campaign: {
        Args: { p_worker: string }
        Returns: {
          audience: string | null
          brand_voice: string | null
          claimed_at: string | null
          claimed_by: string | null
          cost_usd: number
          created_at: string
          credit_budget: number
          credits_spent: number
          current_node: string | null
          error: string | null
          goal: string
          has_video_stream: boolean | null
          heartbeat_at: string | null
          id: string
          max_assets: number
          max_video_seconds: number
          platforms: string[]
          replan_count: number
          source_duration_sec: number | null
          source_path: string | null
          status: string
          title: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "campaigns"
          isOneToOne: false
          isSetofReturn: true
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
